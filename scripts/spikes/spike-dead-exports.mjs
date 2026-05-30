#!/usr/bin/env node
/**
 * Spike A: Dead-export detection — graph query vs ts-prune.
 *
 * Question: how close does a simple "no incoming edges" graph query
 * come to ts-prune's type-aware analysis?
 *
 * Method:
 *   1. Run ts-prune, parse its output → ground-truth set of unused exports
 *   2. Walk indexed nodes, find isExported nodes with no incoming edges
 *      from outside their own file → cartograph "dead exports" set
 *   3. Compare overlap, false positives, false negatives
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? process.cwd());
const { Cartograph } = await import('../../dist/index.js');

console.log(`\n=== Spike A: Dead-export comparison on ${target} ===\n`);

// 1. Get ts-prune output
console.log('Running ts-prune...');
let tsPruneOutput;
try {
  tsPruneOutput = execFileSync('npx', ['ts-prune'], { cwd: target, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
} catch (e) {
  console.error('ts-prune failed:', e.message);
  process.exit(1);
}

// Parse: `src/path.ts:42 - symbolName` (and "(used in module)" suffix)
const tsPruneStrict = new Set();   // all entries, including "used in module"
const tsPruneLoose = new Set();    // only truly-unused (no "(used in module)")
for (const line of tsPruneOutput.split('\n')) {
  const m = line.match(/^(.+?):(\d+) - (\S+)(?:\s+\(used in module\))?\s*$/);
  if (!m) continue;
  const [, file, lineno, name] = m;
  const usedInModule = line.includes('(used in module)');
  const key = `${file}:${name}`;
  tsPruneStrict.add(key);
  if (!usedInModule) tsPruneLoose.add(key);
}
console.log(`  ts-prune strict: ${tsPruneStrict.size} entries (incl. "used in module")`);
console.log(`  ts-prune loose:  ${tsPruneLoose.size} entries (truly unused outside file)\n`);

// 2. Cartograph version: indexed exports with no external incoming edges
console.log('Indexing with cartograph...');
const cgDir = path.join(target, '.cartograph');
import('node:fs').then(({ rmSync, existsSync }) => existsSync(cgDir) && rmSync(cgDir, { recursive: true, force: true }));
const cg = await Cartograph.init(target);
await cg.indexAll();

// Walk all exported nodes, count incoming edges from outside the file.
// We need direct DB access for this — use the underlying SQLite handle.
const db = cg.db.getDb();
const exportedNodes = db.prepare(`
  SELECT id, kind, name, file_path, start_line
  FROM nodes
  WHERE is_exported = 1
    AND kind IN ('function', 'method', 'class', 'interface', 'type_alias', 'constant', 'enum', 'variable')
    AND file_path NOT LIKE '%test%'
    AND file_path NOT LIKE '%.d.ts'
`).all();
console.log(`  ${exportedNodes.length} exported symbols indexed`);

const incomingStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM edges e
  JOIN nodes src ON src.id = e.source
  WHERE e.target = ?
    AND e.kind IN ('calls', 'references', 'type_of', 'instantiates', 'extends', 'implements', 'imports')
    AND src.file_path != ?
`);

const cgDead = new Set();   // file:name keys of nodes with zero external incoming
let nodesChecked = 0;
for (const n of exportedNodes) {
  const { c } = incomingStmt.get(n.id, n.file_path);
  nodesChecked++;
  if (c === 0) {
    cgDead.add(`${n.file_path}:${n.name}`);
  }
}
console.log(`  cartograph dead (no external incoming): ${cgDead.size} of ${nodesChecked}\n`);

// 3. Compare
function intersect(a, b) { return new Set([...a].filter((x) => b.has(x))); }
function diff(a, b) { return new Set([...a].filter((x) => !b.has(x))); }

const overlapStrict = intersect(cgDead, tsPruneStrict);
const overlapLoose = intersect(cgDead, tsPruneLoose);
const cgOnly = diff(cgDead, tsPruneStrict);  // cg says dead, ts-prune doesn't
const tsLooseOnly = diff(tsPruneLoose, cgDead);  // ts-prune-loose says dead, cg doesn't

console.log('=== Comparison ===\n');
console.log(`Strict ts-prune ∩ cartograph: ${overlapStrict.size} / ${cgDead.size} cg-dead = ${(100 * overlapStrict.size / cgDead.size).toFixed(0)}% precision`);
console.log(`                              ${overlapStrict.size} / ${tsPruneStrict.size} ts-strict = ${(100 * overlapStrict.size / tsPruneStrict.size).toFixed(0)}% recall (vs strict)`);
console.log(`Loose ts-prune ∩ cartograph:  ${overlapLoose.size} / ${tsPruneLoose.size} ts-loose = ${(100 * overlapLoose.size / tsPruneLoose.size).toFixed(0)}% recall (vs loose)\n`);

console.log('Cartograph says dead, ts-prune disagrees (potential cartograph false positives):');
[...cgOnly].slice(0, 8).forEach((k) => console.log(`  ${k}`));
console.log(`  (${cgOnly.size} total)\n`);

console.log('ts-prune (loose) says dead, cartograph misses (potential cartograph false negatives):');
[...tsLooseOnly].slice(0, 8).forEach((k) => console.log(`  ${k}`));
console.log(`  (${tsLooseOnly.size} total)\n`);

cg.close();
console.log('=== Spike A complete ===\n');
