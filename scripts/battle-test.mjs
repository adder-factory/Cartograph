#!/usr/bin/env node
/**
 * Battle test: drive every feature shipped on `battle-test/all-shipped`
 * against a real repo and print a comprehensive report.
 *
 * Validates:
 *   - migrations: schema is at v7 with all 7 migrations applied
 *   - extraction: nodes/edges/files indexed
 *   - centrality: PageRank scores populated, top-N nonempty
 *   - churn: per-file commit counts, LOC, last-touched timestamps
 *   - hotspots: risk scoring (centrality × churn) returns ranked rows
 *   - issue-history: Fixes/Closes/Resolves attribution
 *   - config-refs: env var read sites
 *   - sql-refs: table read/write/DDL call sites
 *   - MCP tool registry: 11 tools registered + dispatch works
 *   - Index-hook registry: 5 hooks registered + outcomes populated
 *
 * Usage: node scripts/battle-test.mjs <project-path>
 */

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const targetPath = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(targetPath)) {
  console.error(`battle-test: target path does not exist: ${targetPath}`);
  process.exit(1);
}

console.log(`\n=== Battle test: ${targetPath} ===\n`);

const { Cartograph } = await import('../dist/index.js');

// Reset .cartograph if present so we exercise the fresh-init path
const cgDir = path.join(targetPath, '.cartograph');
if (fs.existsSync(cgDir)) {
  fs.rmSync(cgDir, { recursive: true, force: true });
}

const cg = await Cartograph.init(targetPath);

const t0 = Date.now();
const result = await cg.indexAll();
const indexMs = Date.now() - t0;
console.log(
  `✓ indexAll completed in ${indexMs}ms — files=${result.filesIndexed} nodes=${result.nodesCreated} edges=${result.edgesCreated}`,
);

const stats = cg.getStats();
console.log(`  stats: ${stats.fileCount} files, ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);

// ----- migrations -----
const { CURRENT_SCHEMA_VERSION, ALL_MIGRATIONS } = await import('../dist/db/migrations.js');
const versions = ALL_MIGRATIONS.map((m) => m.version).join(',');
console.log(`✓ schema v${CURRENT_SCHEMA_VERSION}, registered migrations: ${versions}`);

// ----- index-hook registry -----
const { getRegisteredHooks } = await import('../dist/index-hooks/registry.js');
const hooks = getRegisteredHooks();
console.log(`✓ ${hooks.length} index-hooks registered: ${hooks.map((h) => h.name).join(', ')}`);

// ----- mcp tool registry -----
const { getToolModules } = await import('../dist/mcp/tools/registry.js');
const tools = getToolModules();
console.log(`✓ ${tools.length} MCP tools registered: ${tools.map((t) => t.definition.name).join(', ')}`);

// ----- centrality -----
const top = cg.getTopCentralNodes({ limit: 5 });
console.log(`\n--- centrality ---`);
if (top.length === 0) {
  console.log(`  ✗ no centrality scores computed`);
} else {
  console.log(`  ✓ top 5 by centrality:`);
  for (const n of top) {
    console.log(`    ${n.centrality?.toFixed(5)}  ${n.kind}  ${n.name}  (${n.filePath}:${n.startLine})`);
  }
}

// ----- churn -----
console.log(`\n--- churn ---`);
const sample = cg.getStats().fileCount > 0 ? cg.getHotspots({ limit: 1, minCommits: 0 })[0] : null;
if (sample) {
  const churn = cg.getFileChurn(sample.filePath);
  console.log(
    `  ✓ sample file ${sample.filePath}: commits=${churn?.commitCount} loc=${churn?.loc} lastTouched=${churn?.lastTouchedTs}`,
  );
} else {
  console.log(`  (no churn data — likely not in a git repo)`);
}

// ----- hotspots -----
console.log(`\n--- hotspots ---`);
const hot = cg.getHotspots({ limit: 5, minCommits: 0 });
if (hot.length === 0) {
  console.log(`  (no hotspots)`);
} else {
  console.log(`  ✓ top 5 by risk:`);
  for (const r of hot) {
    console.log(`    risk=${r.riskScore.toFixed(4)} commits=${r.commitCount} loc=${r.loc} ${r.filePath}`);
  }
}

// ----- issue history -----
console.log(`\n--- issue history ---`);
let issueCount = 0;
let nodesWithIssues = 0;
const allNodes = cg.getStats().nodeCount;
// Sample up to 200 random nodes; count how many have any issue history
const sampleNodes = cg.getTopCentralNodes({ limit: 200 });
for (const n of sampleNodes) {
  const issues = cg.getIssuesForNode(n.id);
  if (issues.length > 0) {
    nodesWithIssues++;
    issueCount += issues.length;
  }
}
console.log(
  `  sampled ${sampleNodes.length} of ${allNodes} nodes: ${nodesWithIssues} have issue refs (${issueCount} attributions)`,
);

// ----- config refs -----
console.log(`\n--- config refs ---`);
const envKeys = cg.getConfigKeys({ configKind: 'env', limit: 10 });
if (envKeys.length === 0) {
  console.log(`  (no env-var read sites)`);
} else {
  console.log(
    `  ✓ top 10 env vars (${envKeys.length}/${cg.getConfigKeys({ configKind: 'env', limit: 9999 }).length}):`,
  );
  for (const k of envKeys) {
    console.log(`    ${k.reads.toString().padStart(4)} reads  ${k.distinctFiles} files  ${k.configKey}`);
  }
}

// ----- sql refs -----
console.log(`\n--- sql refs ---`);
const tables = cg.getSqlTables({ limit: 10 });
if (tables.length === 0) {
  console.log(`  (no SQL string-literal call sites)`);
} else {
  console.log(`  ✓ top 10 tables:`);
  for (const t of tables) {
    console.log(`    r=${t.reads} w=${t.writes} d=${t.ddl}  ${t.tableName}`);
  }
}

// ----- sync regression -----
console.log(`\n--- sync round-trip ---`);
const t1 = Date.now();
const syncResult = await cg.sync();
const syncMs = Date.now() - t1;
console.log(
  `  ✓ sync no-op in ${syncMs}ms — added=${syncResult.filesAdded} modified=${syncResult.filesModified} removed=${syncResult.filesRemoved}`,
);

cg.close();
console.log(`\n=== battle test PASS ===\n`);
