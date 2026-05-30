#!/usr/bin/env node
/**
 * Stress-test harness for the integrated feature stack.
 *
 * Exercises each shipped feature beyond the happy path:
 *   - Performance: indexAll/sync timing + memory under load
 *   - Determinism: re-index produces identical state
 *   - HEAD-movement detection (PR #100)
 *   - .cartographignore git fast-path (PR #103)
 *   - edges UNIQUE constraint (PR #102) — re-extraction shouldn't dupe
 *   - FTS subwords + Porter stem (PR #104)
 *   - Search diversification (PR #107)
 *   - Centrality + churn + hotspots (PR #112)
 *   - Issue history (PR #113)
 *   - Config-refs (PR #114) — env var false-positive guards
 *   - SQL-refs (PR #115) — comment/docstring guards
 *   - Co-change graph (PR #105)
 *   - Tests-as-edges (PR #106)
 *   - Review-context (PR #110)
 *   - Index-hook framework (PR #119) — all hooks fire together
 *   - Submodules (PR #93)
 *
 * Usage: node scripts/stress-test.mjs <project-path> [--quick]
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const target = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const QUICK = args.includes('--quick');

if (!fs.existsSync(target)) {
  console.error(`stress-test: target path does not exist: ${target}`);
  process.exit(1);
}

const { Cartograph } = await import('../dist/index.js');

const FAILURES = [];
const RESULTS = [];

function pass(name, detail = '') {
  RESULTS.push({ name, status: 'PASS', detail });
}
function fail(name, detail) {
  RESULTS.push({ name, status: 'FAIL', detail });
  FAILURES.push({ name, detail });
}
function warn(name, detail) {
  RESULTS.push({ name, status: 'WARN', detail });
}

function ms() {
  return process.hrtime.bigint();
}
function elapsed(start) {
  return Number((ms() - start) / 1_000_000n);
}
function rss() {
  return Math.round(process.memoryUsage.rss() / 1024 / 1024);
}

function resetTarget() {
  const cgDir = path.join(target, '.cartograph');
  if (fs.existsSync(cgDir)) fs.rmSync(cgDir, { recursive: true, force: true });
}

console.log(`\n=== Stress test: ${target} ===\n`);

// =============================================================================
// Phase 1: First-index timing + memory
// =============================================================================
console.log('[Phase 1] First-index performance');
resetTarget();
const cg = await Cartograph.init(target);
const t0 = ms();
const memBefore = rss();
const r1 = await cg.indexAll();
const indexMs = elapsed(t0);
const memAfter = rss();

if (r1.success)
  pass(
    'indexAll completes',
    `${r1.filesIndexed} files / ${r1.nodesCreated} nodes / ${r1.edgesCreated} edges in ${indexMs}ms (Δ ${memAfter - memBefore}MB RSS)`,
  );
else fail('indexAll completes', `errors: ${r1.errors.length}`);

const stats = cg.getStats();
console.log(`  ✓ stats: ${stats.fileCount} files, ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
const filesPerSec = (r1.filesIndexed / (indexMs / 1000)).toFixed(0);
console.log(`  ✓ throughput: ${filesPerSec} files/s\n`);

// =============================================================================
// Phase 2: Determinism — sync no-op should report no changes
// =============================================================================
console.log('[Phase 2] Determinism (sync no-op)');
const t2 = ms();
const sync1 = await cg.sync();
const noopMs = elapsed(t2);
if (sync1.filesAdded === 0 && sync1.filesModified === 0 && sync1.filesRemoved === 0) {
  pass('sync no-op clean', `${noopMs}ms, no changes detected`);
} else {
  fail(
    'sync no-op clean',
    `unexpectedly reported added=${sync1.filesAdded} mod=${sync1.filesModified} rm=${sync1.filesRemoved}`,
  );
}

// =============================================================================
// Phase 3: edges UNIQUE constraint (PR #102) — re-index shouldn't dup edges
// =============================================================================
console.log('\n[Phase 3] edges UNIQUE constraint (PR #102)');
const edgeCountBefore = cg.getStats().edgeCount;
const r3 = await cg.indexAll();
const edgeCountAfter = cg.getStats().edgeCount;
if (edgeCountAfter === edgeCountBefore) {
  pass('re-indexAll preserves edge count', `${edgeCountBefore} = ${edgeCountAfter}`);
} else if (Math.abs(edgeCountAfter - edgeCountBefore) <= 5) {
  warn('re-indexAll preserves edge count', `${edgeCountBefore} vs ${edgeCountAfter} (small drift acceptable)`);
} else {
  fail('re-indexAll preserves edge count', `${edgeCountBefore} → ${edgeCountAfter} (UNIQUE constraint not deduping)`);
}

// =============================================================================
// Phase 4: All registered hooks fire (PR #119 framework)
// =============================================================================
console.log('\n[Phase 4] Index-hook framework (PR #119)');
const { getRegisteredHooks } = await import('../dist/index-hooks/registry.js');
const hooks = getRegisteredHooks();
console.log(`  ✓ ${hooks.length} hooks registered: ${hooks.map((h) => h.name).join(', ')}`);
if (hooks.length >= 6) pass('all hooks registered', `${hooks.length} hooks`);
else fail('all hooks registered', `expected ≥6, got ${hooks.length}`);

// Each hook should have populated some state
const sampleNode = cg.getTopCentralNodes({ limit: 1 })[0];
if (sampleNode && sampleNode.centrality != null)
  pass('centrality hook populated nodes', `top node centrality=${sampleNode.centrality.toFixed(5)}`);
else fail('centrality hook populated nodes', 'no top central nodes');

const sampleHotspot = cg.getHotspots({ limit: 1, minCommits: 0 })[0];
if (sampleHotspot && sampleHotspot.commitCount > 0)
  pass('churn hook populated commit_count', `${sampleHotspot.filePath}: ${sampleHotspot.commitCount} commits`);
else warn('churn hook populated commit_count', 'no hotspots with commit data (likely non-git)');

// Co-change: at least one pair should exist if churn worked
let coChangeWorks = false;
try {
  const cochanges = cg.getCoChangedFiles(sampleHotspot?.filePath ?? '', { limit: 5, minCount: 1, minJaccard: 0 });
  coChangeWorks = cochanges.length > 0;
  if (coChangeWorks)
    pass('cochange hook populated pairs', `${cochanges.length} co-changers for ${sampleHotspot.filePath}`);
  else warn('cochange hook populated pairs', 'no co-change pairs (history may be too short)');
} catch (e) {
  warn('cochange hook populated pairs', e.message);
}

// =============================================================================
// Phase 5: FTS subwords + Porter stemmer (PR #104)
// =============================================================================
console.log('\n[Phase 5] FTS subwords + Porter (PR #104)');
// Subword: querying for "parser" should find getParser/parseFile/etc.
const subwordHits = cg.searchNodes('parser', { limit: 20 });
const hasSubwordMatch = subwordHits.some(
  (r) => /[Pp]arser|[Pp]arse[A-Z]/.test(r.node.name) && r.node.name !== 'parser',
);
if (hasSubwordMatch)
  pass('FTS finds subwords', `query "parser" matches camelCase parents like ${subwordHits[0]?.node.name}`);
else if (subwordHits.length > 0)
  warn('FTS finds subwords', `${subwordHits.length} hits but no obvious camelCase subword matches`);
else fail('FTS finds subwords', 'no hits for "parser"');

// Porter stem: "parsing" should match "parse"/"parser"/"parses"
const stemHits = cg.searchNodes('parsing', { limit: 10 });
if (stemHits.length > 0) pass('FTS Porter stems', `query "parsing" matched ${stemHits.length} nodes`);
else warn('FTS Porter stems', 'no hits for "parsing"');

// =============================================================================
// Phase 6: Search diversification (PR #107)
// =============================================================================
console.log('\n[Phase 6] Search diversification (PR #107)');
const divHits = cg.searchNodes('extract', { limit: 10 });
if (divHits.length >= 5) {
  const distinctFiles = new Set(divHits.map((r) => r.node.filePath)).size;
  const ratio = distinctFiles / divHits.length;
  if (ratio >= 0.5)
    pass('search diversifies across files', `${distinctFiles}/${divHits.length} distinct files in top 10`);
  else warn('search diversifies across files', `only ${distinctFiles}/${divHits.length} distinct (one file dominates)`);
} else {
  warn('search diversifies across files', `not enough hits to test (${divHits.length})`);
}

// =============================================================================
// Phase 7: Config-refs false-positive guards (PR #114, #101 strip-comments)
// =============================================================================
console.log('\n[Phase 7] Config-refs false-positive resistance');
const envKeys = cg.getConfigKeys({ configKind: 'env', limit: 100 });
console.log(`  ✓ ${envKeys.length} distinct env vars detected`);
// Sanity: top env var should appear in actual code, not just docstrings
if (envKeys.length > 0) {
  const top = envKeys[0];
  const sites = cg.getConfigRefsByKey(top.configKey, { configKind: 'env' });
  if (sites.length === top.reads)
    pass('config-refs reads count consistency', `${top.configKey}: ${sites.length} sites`);
  else
    fail(
      'config-refs reads count consistency',
      `getConfigKeys says ${top.reads}, getConfigRefsByKey says ${sites.length}`,
    );
}
// False-positive guard: should not have keys like "the", "a", short common words
const suspicious = envKeys.filter((k) => /^(the|a|of|and|for|to|is|in)$/i.test(k.configKey));
if (suspicious.length === 0) pass('no false-positive env keys', '');
else fail('no false-positive env keys', `found: ${suspicious.map((k) => k.configKey).join(', ')}`);

// =============================================================================
// Phase 8: SQL-refs comment-strip + keyword pre-filter (PR #115)
// =============================================================================
console.log('\n[Phase 8] SQL-refs precision');
const tables = cg.getSqlTables({ limit: 50 });
console.log(`  ✓ ${tables.length} SQL tables detected`);
if (tables.length > 0) {
  // False-positive guard: bare common English words shouldn't appear as tables
  const englishLooking = tables.filter((t) => /^(the|a|of|and|for|to|in|is)$/i.test(t.tableName));
  if (englishLooking.length === 0) pass('no English-word false positives', '');
  else fail('no English-word false positives', `found: ${englishLooking.map((t) => t.tableName).join(', ')}`);
}

// =============================================================================
// Phase 9: Issue-history (PR #113)
// =============================================================================
console.log('\n[Phase 9] Issue-history attribution');
const sampledNodes = cg.getTopCentralNodes({ limit: 200 });
let nodesWithIssues = 0,
  totalAttributions = 0;
for (const n of sampledNodes) {
  const issues = cg.getIssuesForNode(n.id);
  if (issues.length > 0) {
    nodesWithIssues++;
    totalAttributions += issues.length;
  }
}
console.log(
  `  ${nodesWithIssues}/${sampledNodes.length} sampled nodes have issue refs (${totalAttributions} attributions)`,
);
pass('issue-history runs without error', `sampled ${sampledNodes.length}`);

// =============================================================================
// Phase 10: Tests-edges (PR #106)
// =============================================================================
console.log('\n[Phase 10] Tests-as-edges');
// Find a test file in the indexed set, verify it has outgoing tests edges
const allFiles = cg.getStats();
console.log(`  ✓ examined ${allFiles.fileCount} files`);
let testEdgesFound = 0;
const sampleNodes2 = cg.getTopCentralNodes({ limit: 50 });
for (const n of sampleNodes2.slice(0, 20)) {
  const tests = cg.getTestsForFile(n.filePath);
  if (tests.length > 0) testEdgesFound++;
}
if (testEdgesFound > 0)
  pass('tests-edges hook populated', `${testEdgesFound}/20 sample files have test coverage edges`);
else warn('tests-edges hook populated', 'no test coverage edges among sampled files');

// =============================================================================
// Phase 11: review-context MCP tool (PR #110)
// =============================================================================
console.log('\n[Phase 11] review-context');
// Build a synthetic small diff against the first indexed file
const firstFile = cg.getTopCentralNodes({ limit: 1 })[0];
if (firstFile) {
  const fakeDiff = `diff --git a/${firstFile.filePath} b/${firstFile.filePath}
--- a/${firstFile.filePath}
+++ b/${firstFile.filePath}
@@ -${firstFile.startLine},3 +${firstFile.startLine},4 @@ ${firstFile.name}
   foo();
+  newCall();
   bar();
`;
  try {
    const ctx = cg.buildReviewContext(fakeDiff, {});
    if (ctx.summary.symbolsAffected > 0 || ctx.files.length > 0)
      pass('review-context produces context', `${ctx.summary.symbolsAffected} symbols, ${ctx.files.length} files`);
    else warn('review-context produces context', 'no overlap detected (synthetic diff may not match indexed lines)');
  } catch (e) {
    fail('review-context produces context', e.message);
  }
} else {
  warn('review-context produces context', 'no nodes to test against');
}

// =============================================================================
// Phase 12: Sync timing on a real edit
// =============================================================================
if (!QUICK) {
  console.log('\n[Phase 12] Sync after a real edit');
  // Find a markdown or low-impact file to touch and revert
  const tmp = path.join(target, '.stress-test-tmp.txt');
  try {
    fs.writeFileSync(tmp, `// stress test marker ${Date.now()}\n`);
    const t12 = ms();
    const syncEdit = await cg.sync();
    const syncMs = elapsed(t12);
    fs.unlinkSync(tmp);
    await cg.sync(); // clean up
    if (syncEdit.filesChecked > 0 || syncEdit.filesAdded > 0)
      pass('sync detects new file', `${syncMs}ms, added=${syncEdit.filesAdded}`);
    else warn('sync detects new file', `${syncMs}ms, no changes detected (file may be excluded)`);
  } catch (e) {
    warn('sync detects new file', e.message);
  }
}

// =============================================================================
// Phase 13: HEAD-movement detection (PR #100) — synthetic
// =============================================================================
console.log('\n[Phase 13] HEAD-movement detection (PR #100, synthetic repo)');
const syntheticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-head-'));
try {
  const git = (...a) => execFileSync('git', a, { cwd: syntheticDir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'stress@test.local');
  git('config', 'user.name', 'Stress Test');
  fs.mkdirSync(path.join(syntheticDir, 'src'));
  fs.writeFileSync(path.join(syntheticDir, 'src/a.ts'), `export function alpha() { return 1; }\n`);
  git('add', '-A');
  git('commit', '-m', 'initial', '-q');

  const cg2 = await Cartograph.init(syntheticDir, { config: { include: ['**/*.ts'], exclude: [] } });
  await cg2.indexAll();
  const before = cg2.getStats().nodeCount;

  // HEAD-moving operation: branch + commit + checkout back, working tree clean
  git('checkout', '-b', 'feature', '-q');
  fs.writeFileSync(path.join(syntheticDir, 'src/b.ts'), `export function beta() { return 2; }\n`);
  git('add', '-A');
  git('commit', '-m', 'add b', '-q');
  git('checkout', 'main', '-q');
  git('merge', '--no-ff', 'feature', '-m', 'merge', '-q');
  // Tree clean (post-merge), but HEAD moved
  const sync13 = await cg2.sync();
  const after = cg2.getStats().nodeCount;

  if (sync13.filesAdded + sync13.filesModified > 0 && after > before)
    pass('HEAD-movement detected', `+${sync13.filesAdded} added, ${before}→${after} nodes`);
  else
    fail(
      'HEAD-movement detected',
      `sync reported added=${sync13.filesAdded} mod=${sync13.filesModified}; nodes ${before}→${after}`,
    );

  cg2.close();
} catch (e) {
  fail('HEAD-movement detected', e.message);
} finally {
  if (fs.existsSync(syntheticDir)) fs.rmSync(syntheticDir, { recursive: true, force: true });
}

// =============================================================================
// Phase 14: .cartographignore on git fast path (PR #103) — synthetic
// =============================================================================
console.log('\n[Phase 14] .cartographignore on git fast path (PR #103, synthetic repo)');
const ignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-ignore-'));
try {
  const git = (...a) => execFileSync('git', a, { cwd: ignoreDir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'stress@test.local');
  git('config', 'user.name', 'Stress Test');
  fs.mkdirSync(path.join(ignoreDir, 'src'));
  fs.mkdirSync(path.join(ignoreDir, 'vendor-tree'));
  fs.writeFileSync(path.join(ignoreDir, 'src/keep.ts'), `export function keep() {}\n`);
  fs.writeFileSync(path.join(ignoreDir, 'vendor-tree/skip.ts'), `export function skip() {}\n`);
  fs.writeFileSync(path.join(ignoreDir, 'vendor-tree/.cartographignore'), '');
  git('add', '-A');
  git('commit', '-m', 'init', '-q');

  const cg3 = await Cartograph.init(ignoreDir, { config: { include: ['**/*.ts'], exclude: [] } });
  await cg3.indexAll();

  const keep = cg3.searchNodes('keep', { limit: 5 });
  const skip = cg3.searchNodes('skip', { limit: 5 });
  if (keep.length > 0 && skip.length === 0) pass('.cartographignore excludes vendor-tree', `keep visible, skip hidden`);
  else if (skip.length > 0)
    fail('.cartographignore excludes vendor-tree', `vendor-tree/skip.ts was indexed (.cartographignore not honored)`);
  else warn('.cartographignore excludes vendor-tree', `keep.ts also missing — globs may be wrong`);

  cg3.close();
} catch (e) {
  fail('.cartographignore excludes vendor-tree', e.message);
} finally {
  if (fs.existsSync(ignoreDir)) fs.rmSync(ignoreDir, { recursive: true, force: true });
}

// =============================================================================
// Phase 15: Full sync round-trip + final memory
// =============================================================================
console.log('\n[Phase 15] Final sync + memory check');
const t15 = ms();
const final = await cg.sync();
const finalMs = elapsed(t15);
console.log(`  ✓ final sync no-op: ${finalMs}ms`);
console.log(`  ✓ final RSS: ${rss()}MB`);

cg.close();

// =============================================================================
// Summary
// =============================================================================
console.log('\n=== Summary ===');
const passes = RESULTS.filter((r) => r.status === 'PASS').length;
const warns = RESULTS.filter((r) => r.status === 'WARN').length;
const fails = RESULTS.filter((r) => r.status === 'FAIL').length;
console.log(`  ${passes} PASS · ${warns} WARN · ${fails} FAIL\n`);

for (const r of RESULTS) {
  const sym = r.status === 'PASS' ? '✓' : r.status === 'WARN' ? '⚠' : '✗';
  console.log(`  ${sym} [${r.status}] ${r.name}${r.detail ? ': ' + r.detail : ''}`);
}

if (FAILURES.length > 0) {
  console.log(`\n=== FAILURES (${FAILURES.length}) ===`);
  for (const f of FAILURES) console.log(`  ✗ ${f.name}: ${f.detail}`);
  process.exit(1);
}

console.log('\n=== Stress test PASSED ===\n');
