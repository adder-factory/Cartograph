/**
 * One-off probe — runs each of the 6 cross-file biomarker rules once
 * in its own worker_thread and dumps the per-rule wall time so we
 * can see which rules are the long pole.
 *
 * Used to decide whether the queued "G9 internal parallelism"
 * follow-up (worker-internal parallelism for the heavy rules) is
 * worth the complexity on a given corpus. The pool's wall is
 * `~spawn + max(per-rule)`, so only the longest rule(s) matter.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path/to/project bun bench/probe-cross-file-rule-timings.mts
 *
 * Defaults to the cartograph repo itself if BENCH_PROJECT_DIR is unset.
 */

import * as path from 'path';
import { runRulesInWorkers } from '../src/biomarkers/worker-pool.js';
import { CROSS_FILE_RULES } from '../src/biomarkers/index.js';

async function main(): Promise<void> {
  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  const dbPath = path.join(projectRoot, '.cartograph', 'cartograph.db');
  const passes = Number(process.env['BENCH_PASSES'] ?? 3);

  console.log(`probing cross-file rule timings against: ${projectRoot}`);
  console.log(`passes per rule: ${passes}\n`);

  const ruleKinds = CROSS_FILE_RULES.map((r) => r.kind);
  const samples = new Map<string, number[]>();
  for (const k of ruleKinds) samples.set(k, []);

  for (let i = 0; i < passes; i++) {
    const results = await runRulesInWorkers({ dbPath, projectRoot, ruleKinds, perRuleTimeoutMs: 600_000 });
    for (const r of results) {
      const arr = samples.get(r.ruleKind);
      if (arr) arr.push(r.durationMs);
      if (r.error) console.log(`  ${r.ruleKind}: error — ${r.error}`);
    }
  }

  const median = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  const rows = ruleKinds.map((k) => {
    const arr = samples.get(k) ?? [];
    return {
      rule: k,
      min: arr.length > 0 ? Math.min(...arr) : 0,
      med: median(arr),
      max: arr.length > 0 ? Math.max(...arr) : 0,
      raw: arr,
    };
  });
  rows.sort((a, b) => b.med - a.med);

  console.log('per-rule timings (ms):');
  console.log(`  ${'rule'.padEnd(18)} ${'min'.padStart(7)} ${'median'.padStart(7)} ${'max'.padStart(7)}   raw samples`);
  for (const row of rows) {
    console.log(
      `  ${row.rule.padEnd(18)} ${String(row.min).padStart(7)} ${String(row.med).padStart(7)} ${String(row.max).padStart(7)}   [${row.raw.join(', ')}]`,
    );
  }

  const longPole = rows[0];
  if (longPole) {
    const sumOthers = rows.slice(1).reduce((s, r) => s + r.med, 0);
    console.log(
      `\nlong pole: ${longPole.rule} (${longPole.med}ms median).` +
        ` Sum of OTHER 5 rules: ${sumOthers}ms.` +
        ` Worker pool wall ≈ spawn + ${longPole.med}ms.`,
    );
    console.log(
      `Inner-parallelism gain ceiling: at best the long pole drops to ~${Math.max(...rows.slice(1).map((r) => r.med))}ms (the NEW long pole).`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
