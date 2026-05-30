#!/usr/bin/env node
/**
 * Spike D: PR risk-delta meaningfulness.
 *
 * Question: when a PR touches files, does the rank-shift in the hotspot
 * list (after applying the touched_count += 1) correlate with risk
 * intuition? Or do most PRs produce trivial shifts?
 *
 * Method:
 *   1. Get current hotspot ranking (anchor)
 *   2. For each of the last N real commits, simulate "after this commit":
 *      - For each file the commit touched, conceptually +1 to commit_count
 *      - Recompute risk = file_centrality * commit_count
 *      - Find what the new top-K would look like
 *   3. Tabulate per-commit: max rank shift, avg rank shift, files that
 *      newly entered top-10
 *   4. Decide: are the shifts informative, or noise?
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';

const target = path.resolve(process.argv[2] ?? process.cwd());
const N_COMMITS = 20;
const { Cartograph } = await import('../../dist/index.js');

console.log(`\n=== Spike D: Risk-delta on ${path.basename(target)} (last ${N_COMMITS} commits) ===\n`);

const cg = await Cartograph.open(target);

// 1. Anchor: current hotspot ranking
const anchor = cg.getHotspots({ limit: 200, minCommits: 0, sortBy: 'risk' });
const rankByPath = new Map();
anchor.forEach((h, i) => rankByPath.set(h.filePath, { rank: i + 1, risk: h.riskScore, centrality: h.fileCentrality, commits: h.commitCount }));
console.log(`Anchor: ${anchor.length} files ranked by risk\n`);
console.log('Top 5 anchor:');
anchor.slice(0, 5).forEach((h, i) => console.log(`  #${i + 1} risk=${h.riskScore.toFixed(3)} · ${h.filePath}`));
console.log();

// 2. For each of the last N commits, simulate the rank shift
const shaList = execFileSync('git', ['log', '-n', String(N_COMMITS), '--format=%H'], { cwd: target, encoding: 'utf-8' })
  .trim().split('\n');

console.log('Per-commit rank-shift analysis:\n');
console.log(`${'commit'.padEnd(8)} ${'subject'.padEnd(50)} ${'files'.padStart(5)} ${'avgΔ'.padStart(6)} ${'maxΔ'.padStart(6)} new-in-top10`);
console.log('-'.repeat(95));

const allShifts = [];
const interestingCommits = [];
for (const sha of shaList) {
  const subject = execFileSync('git', ['log', '-1', '--format=%s', sha], { cwd: target, encoding: 'utf-8' }).trim();
  const filesRaw = execFileSync('git', ['show', '--name-only', '--format=', sha], { cwd: target, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);
  // Filter to files cartograph knows
  const touched = filesRaw.filter((f) => rankByPath.has(f));
  if (touched.length === 0) continue;

  // Simulate: increment commit_count by 1 for each touched file
  const simulated = anchor.map((h) => {
    const newCommits = touched.includes(h.filePath) ? h.commitCount + 1 : h.commitCount;
    const newRisk = h.fileCentrality * newCommits;
    return { filePath: h.filePath, newRisk };
  });
  simulated.sort((a, b) => b.newRisk - a.newRisk);

  // Compute shifts
  const newRankByPath = new Map();
  simulated.forEach((s, i) => newRankByPath.set(s.filePath, i + 1));

  let totalShift = 0, maxShift = 0, newInTop10 = [];
  for (const file of touched) {
    const before = rankByPath.get(file).rank;
    const after = newRankByPath.get(file);
    const shift = before - after;  // positive = climbed (worse)
    totalShift += Math.abs(shift);
    maxShift = Math.max(maxShift, Math.abs(shift));
    if (after <= 10 && before > 10) newInTop10.push(file);
  }
  const avgShift = totalShift / touched.length;
  allShifts.push({ sha, subject, touched: touched.length, avgShift, maxShift, newInTop10 });

  // Print top-line: only show non-trivial commits (>1 file or maxShift>0)
  if (touched.length > 1 || maxShift > 0) {
    const subjShort = subject.length > 48 ? subject.slice(0, 45) + '...' : subject;
    console.log(
      `${sha.slice(0, 7).padEnd(8)} ${subjShort.padEnd(50)} ${String(touched.length).padStart(5)} ${avgShift.toFixed(1).padStart(6)} ${String(maxShift).padStart(6)} ${newInTop10.length > 0 ? '⚡ ' + newInTop10.join(',') : ''}`
    );
  }
  if (newInTop10.length > 0 || maxShift >= 5) interestingCommits.push({ sha, subject, touched, maxShift, newInTop10 });
}

cg.close();

// 3. Verdict
console.log('\n=== Analysis ===\n');
const triviallySmall = allShifts.filter((s) => s.maxShift === 0).length;
const moderate = allShifts.filter((s) => s.maxShift > 0 && s.maxShift < 5).length;
const significant = allShifts.filter((s) => s.maxShift >= 5).length;
console.log(`${triviallySmall} commits: zero rank shift (already-ranked files staying put)`);
console.log(`${moderate} commits: small shift (1-4 ranks)`);
console.log(`${significant} commits: significant shift (≥5 ranks)`);
console.log(`${interestingCommits.length} commits surfaced interesting (top-10 entry or ≥5-rank shift)`);

if (interestingCommits.length > 0) {
  console.log('\nInteresting commits this metric would have flagged:');
  interestingCommits.slice(0, 5).forEach((c) => {
    const subj = c.subject.length > 50 ? c.subject.slice(0, 47) + '...' : c.subject;
    console.log(`  ${c.sha.slice(0, 7)} ${subj}`);
    if (c.newInTop10.length > 0) console.log(`         → newly in top-10: ${c.newInTop10.join(', ')}`);
    else console.log(`         → max ${c.maxShift}-rank climb`);
  });
}

console.log('\n=== Verdict ===');
if (significant >= N_COMMITS / 4) console.log(`Significant rank shifts on ${significant}/${N_COMMITS} commits = ${Math.round(100 * significant / N_COMMITS)}%. Metric is informative. BUILD risk-delta.`);
else if (interestingCommits.length === 0) console.log('Zero meaningful shifts across recent commits. Metric is noise. SKIP.');
else console.log(`Only ${interestingCommits.length}/${N_COMMITS} commits flagged. Marginal signal — informative when it fires but rarely fires. Build only if compounding with other features.`);
