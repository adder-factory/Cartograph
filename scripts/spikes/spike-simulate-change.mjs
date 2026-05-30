#!/usr/bin/env node
/**
 * Spike E: Does cartograph_simulate_change need to exist as a tool,
 * or is cartograph_review_context (existing) already good enough?
 *
 * Method: build a synthetic broken diff (rename a function definition
 * but NOT its callers — a classic refactor mistake) and see whether
 * cartograph_review_context flags the un-renamed callers as a risk.
 *
 *   - If review-context names the un-renamed callers → no need for a
 *     new tool. The existing surface is enough.
 *   - If review-context only sees the touched file → simulate-change
 *     would add real value: it can predict the breakage that the
 *     diff alone doesn't show.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const { Cartograph } = await import('../../dist/index.js');

console.log('\n=== Spike E: simulate-change vs review-context ===\n');

// Build a tiny synthetic codebase
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-simulate-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'spike@test.local');
git('config', 'user.name', 'Spike Test');

fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src/util.ts'), `export function fooBarBaz(x: number): number {
  return x * 2;
}
`);
fs.writeFileSync(path.join(dir, 'src/a.ts'), `import { fooBarBaz } from './util';
export function callerA() {
  return fooBarBaz(1);
}
`);
fs.writeFileSync(path.join(dir, 'src/b.ts'), `import { fooBarBaz } from './util';
export function callerB() {
  return fooBarBaz(2);
}
`);
fs.writeFileSync(path.join(dir, 'src/c.ts'), `import { fooBarBaz } from './util';
export function callerC() {
  return fooBarBaz(3) + fooBarBaz(4);
}
`);
git('add', '-A');
git('commit', '-q', '-m', 'init');

const cg = await Cartograph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });
await cg.indexAll();

console.log('Setup: 4 files, 1 definition (fooBarBaz in util.ts), 4 calls across a.ts/b.ts/c.ts.');
console.log('Indexed nodes:', cg.getStats().nodeCount, '  edges:', cg.getStats().edgeCount, '\n');

// Verify the call graph is correct
const callers = cg.getCallers('fooBarBaz');
console.log(`getCallers(fooBarBaz) → ${callers.length} callers:`);
callers.forEach((c) => console.log(`  ${c.callerNode.name} in ${c.callerNode.filePath}`));
console.log();

// Build a BROKEN diff: rename only the definition, leave callers alone
const brokenDiff = `diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,3 +1,3 @@
-export function fooBarBaz(x: number): number {
+export function bazQux(x: number): number {
   return x * 2;
 }
`;

console.log('Synthetic diff: rename fooBarBaz → bazQux ONLY in util.ts (callers in a/b/c.ts NOT updated)\n');

// Run review-context on the broken diff
const ctx = cg.buildReviewContext(brokenDiff, {});
console.log('=== review-context output ===');
console.log(`summary: ${JSON.stringify(ctx.summary)}`);
console.log(`files in ctx: ${ctx.files.length}`);
ctx.files.forEach((f) => {
  console.log(`  ${f.filePath} (${f.status}) — ${f.affectedSymbols.length} affected symbols`);
  f.affectedSymbols.forEach((s) => {
    console.log(`    ${s.name} (${s.kind})`);
    console.log(`      callers: ${s.callers?.map((c) => c.name).join(', ') ?? '(none)'}`);
    console.log(`      callees: ${s.callees?.map((c) => c.name).join(', ') ?? '(none)'}`);
  });
});

// Crucial question: does review-context surface the callers
// (callerA, callerB, callerC) as needing attention?
const surfacedCallers = new Set();
for (const f of ctx.files) {
  for (const s of f.affectedSymbols) {
    for (const c of s.callers ?? []) {
      surfacedCallers.add(c.name);
    }
  }
}

console.log(`\n=== Analysis ===\n`);
console.log(`Surfaced callers via review-context: ${[...surfacedCallers].join(', ') || '(none)'}`);
const expectedCallers = ['callerA', 'callerB', 'callerC'];
const hits = expectedCallers.filter((c) => surfacedCallers.has(c));

if (hits.length === expectedCallers.length) {
  console.log(`✓ All ${expectedCallers.length} expected callers surfaced. review-context is sufficient.`);
  console.log(`\nVerdict: cartograph_simulate_change adds NO new value. SKIP.`);
} else if (hits.length > 0) {
  console.log(`⚠ Only ${hits.length}/${expectedCallers.length} callers surfaced.`);
  console.log(`Missed: ${expectedCallers.filter((c) => !surfacedCallers.has(c)).join(', ')}`);
  console.log(`\nVerdict: review-context partially covers this. simulate-change might add value for completeness, but not transformative. EVALUATE COST/BENEFIT.`);
} else {
  console.log(`✗ Zero callers surfaced. review-context does NOT see the breakage from this diff.`);
  console.log(`\nVerdict: cartograph_simulate_change adds REAL value — it could predict breakage that review-context misses. BUILD.`);
}

// What does review-context actually show? Does it surface anything actionable?
console.log(`\n=== Diagnostic: what DID review-context tell us? ===`);
console.log(`affected files: ${ctx.files.map((f) => f.filePath).join(', ')}`);
console.log(`coChangeWarnings: ${(ctx.coChangeWarnings ?? []).length}`);

cg.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n=== Spike E complete ===\n');
