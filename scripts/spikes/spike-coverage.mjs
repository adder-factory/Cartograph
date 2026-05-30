#!/usr/bin/env node
/**
 * Spike C: Does merging real coverage data with centrality find
 * different "untested high-leverage" files than convention-based
 * tests-edges?
 *
 * Method:
 *   1. Read coverage/coverage-summary.json (jest/vitest standard format)
 *   2. Get top-30 most-central files via cartograph
 *   3. Find: which central files have <50% line coverage?
 *   4. Compare against the convention-based "no incoming tests edges" finding
 *   5. Are these the same files, or different?
 */

import path from 'node:path';
import fs from 'node:fs';

const target = path.resolve(process.argv[2] ?? process.cwd());
const coverageFile = path.join(target, 'coverage/coverage-summary.json');
if (!fs.existsSync(coverageFile)) {
  console.error(`No coverage file at ${coverageFile}`);
  process.exit(1);
}

const { Cartograph } = await import('../../dist/index.js');

console.log(`\n=== Spike C: Coverage merge vs convention-tests on ${path.basename(target)} ===\n`);

const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf-8'));
const covByPath = new Map();
for (const [absPath, data] of Object.entries(coverage)) {
  if (absPath === 'total') continue;
  const rel = path.relative(target, absPath);
  covByPath.set(rel, {
    lines: data.lines?.pct ?? 0,
    branches: data.branches?.pct ?? 0,
    functions: data.functions?.pct ?? 0,
  });
}
console.log(`Coverage: ${covByPath.size} files have line/branch/function pct\n`);

const cgDir = path.join(target, '.cartograph');
if (fs.existsSync(cgDir)) fs.rmSync(cgDir, { recursive: true, force: true });
const cg = await Cartograph.init(target);
await cg.indexAll();

// Top-30 central files
const centralFiles = cg.getHotspots({ limit: 30, minCommits: 0, sortBy: 'centrality' });
console.log(`${centralFiles.length} hotspots (sorted by centrality)\n`);

// Approach 1: coverage-based untested
const lowCovCentral = [];
for (const f of centralFiles) {
  const cov = covByPath.get(f.filePath);
  if (cov && cov.lines < 50) {
    lowCovCentral.push({ file: f.filePath, centrality: f.fileCentrality, lineCov: cov.lines });
  }
}

// Approach 2: convention-based untested (current implementation)
const conventionUntested = [];
for (const f of centralFiles) {
  const tests = cg.getTestsForFile(f.filePath);
  if (tests.length === 0 && !f.filePath.includes('test')) {
    conventionUntested.push({ file: f.filePath, centrality: f.fileCentrality });
  }
}

console.log('Coverage-based untested (line cov <50%):');
lowCovCentral.slice(0, 10).forEach((f) => console.log(`  ${f.lineCov.toFixed(0)}% cov · centrality ${f.centrality.toFixed(4)} · ${f.file}`));

console.log(`\nConvention-based untested (no tests-edges):`);
conventionUntested.slice(0, 10).forEach((f) => console.log(`  centrality ${f.centrality.toFixed(4)} · ${f.file}`));

// Compare
const covSet = new Set(lowCovCentral.map((f) => f.file));
const convSet = new Set(conventionUntested.map((f) => f.file));
const both = [...covSet].filter((f) => convSet.has(f));
const covOnly = [...covSet].filter((f) => !convSet.has(f));
const convOnly = [...convSet].filter((f) => !covSet.has(f));

console.log(`\n=== Comparison ===\n`);
console.log(`Both methods:        ${both.length} files`);
console.log(`Coverage only:       ${covOnly.length} files (caught by coverage, missed by convention)`);
console.log(`Convention only:     ${convOnly.length} files (caught by convention, NOT a coverage gap)`);

if (covOnly.length > 0) {
  console.log(`\nCoverage-only (these have a test file by convention, but real coverage <50%):`);
  covOnly.slice(0, 5).forEach((f) => console.log(`  ${f}`));
  console.log(`\n  → Coverage data adds genuine value: it sees half-tested files convention misses.`);
}
if (convOnly.length > 0) {
  console.log(`\nConvention-only (no test file, but coverage data shows them tested):`);
  convOnly.slice(0, 5).forEach((f) => console.log(`  ${f}`));
  console.log(`\n  → Convention has false positives: a test exists somewhere with non-conventional name.`);
}

cg.close();

// Verdict
console.log('\n=== Verdict ===');
if (covOnly.length >= 3) console.log('Coverage finds materially different gaps. BUILD coverage integration.');
else if (convOnly.length >= 3) console.log('Convention has false positives that coverage corrects. BUILD coverage integration.');
else console.log('Both methods agree closely. Coverage integration adds little. SKIP — but keep in mind it requires CI to produce coverage.');
