#!/usr/bin/env node
/**
 * Spike B: Does edge-weighted PageRank produce a different top-10
 * than the current uniform PageRank?
 *
 * Method: re-run PageRank on the same edge list with edge weights:
 *   calls=3, instantiates=2, extends=2, implements=2, references=1, type_of=1
 * Compare top-10 against current uniform run.
 *
 * If top-10 mostly the same (≥7 overlap), weights add little signal.
 * If significantly different (≤4 overlap), weights matter — build it.
 */
import path from 'node:path';
const target = path.resolve(process.argv[2] ?? process.cwd());
const { Cartograph } = await import('../../dist/index.js');

console.log(`\n=== Spike B: Weighted PageRank on ${target} ===\n`);

const cg = await Cartograph.open(target);
const db = cg.db.getDb();

// Get current centrality top-10
const current = cg.getTopCentralNodes({ limit: 10 });
console.log('Current PageRank (uniform weights) top 10:');
current.forEach((n, i) => console.log(`  ${i + 1}. ${n.name} (${n.kind}) — ${n.centrality.toFixed(5)} — ${n.filePath}:${n.startLine}`));

// Implement weighted PageRank from the same edges
const allNodes = db.prepare('SELECT id FROM nodes').all();
const edges = db.prepare(`
  SELECT source, target, kind FROM edges
  WHERE kind IN ('calls', 'references', 'type_of', 'instantiates', 'extends', 'implements')
`).all();

const WEIGHTS = {
  calls: 3.0,
  instantiates: 2.0,
  extends: 2.0,
  implements: 2.0,
  references: 1.0,
  type_of: 1.0,
};

const N = allNodes.length;
const idToIdx = new Map();
allNodes.forEach((n, i) => idToIdx.set(n.id, i));

// Build outgoing-weight totals + adjacency
const outgoing = new Float64Array(N);  // total outgoing weight per node
const incoming = new Map();             // target idx -> [(srcIdx, weight)]
for (const e of edges) {
  const s = idToIdx.get(e.source);
  const t = idToIdx.get(e.target);
  if (s == null || t == null) continue;
  const w = WEIGHTS[e.kind] ?? 1.0;
  outgoing[s] += w;
  if (!incoming.has(t)) incoming.set(t, []);
  incoming.get(t).push([s, w]);
}

const damping = 0.85;
let pr = new Float64Array(N).fill(1.0 / N);
const teleport = (1 - damping) / N;

for (let iter = 0; iter < 30; iter++) {
  const next = new Float64Array(N).fill(teleport);
  let dangling = 0;
  for (let i = 0; i < N; i++) if (outgoing[i] === 0) dangling += pr[i];
  const danglingShare = damping * dangling / N;
  for (let i = 0; i < N; i++) next[i] += danglingShare;
  for (const [tIdx, contributors] of incoming) {
    let sum = 0;
    for (const [sIdx, w] of contributors) {
      sum += pr[sIdx] * (w / outgoing[sIdx]);
    }
    next[tIdx] += damping * sum;
  }
  pr = next;
}

// Top 10 by weighted PR
const ranked = [];
for (let i = 0; i < N; i++) ranked.push({ idx: i, pr: pr[i] });
ranked.sort((a, b) => b.pr - a.pr);

const idAtIdx = (idx) => allNodes[idx].id;
const getNode = db.prepare('SELECT id, kind, name, file_path, start_line FROM nodes WHERE id = ?');
console.log('\nWeighted PageRank top 10:');
const weightedTop = [];
for (let i = 0; i < 10 && i < ranked.length; i++) {
  const n = getNode.get(idAtIdx(ranked[i].idx));
  weightedTop.push(n.name);
  console.log(`  ${i + 1}. ${n.name} (${n.kind}) — ${ranked[i].pr.toFixed(5)} — ${n.file_path}:${n.start_line}`);
}

// Compare overlap
const currentTop = current.map((n) => n.name);
const overlap = currentTop.filter((n) => weightedTop.includes(n));
console.log(`\nOverlap: ${overlap.length}/10 names appear in both rankings`);
console.log(`Same:    ${overlap.join(', ') || '(none)'}`);
console.log(`Only in current:  ${currentTop.filter((n) => !weightedTop.includes(n)).join(', ') || '(none)'}`);
console.log(`Only in weighted: ${weightedTop.filter((n) => !currentTop.includes(n)).join(', ') || '(none)'}`);

// Rank correlation: how much do positions shift?
let totalShift = 0;
for (const name of overlap) {
  const a = currentTop.indexOf(name);
  const b = weightedTop.indexOf(name);
  totalShift += Math.abs(a - b);
}
console.log(`Average rank shift among overlap: ${(totalShift / Math.max(overlap.length, 1)).toFixed(1)} positions`);

cg.close();

// Verdict
console.log('\n=== Verdict ===');
if (overlap.length >= 8) console.log('Weighted PR shifts <2 names. Marginal value. SKIP build.');
else if (overlap.length >= 5) console.log('Weighted PR shifts ~3-5 names. Modest value. Build only if other improvements compound.');
else console.log('Weighted PR shifts ≥6 names. Significantly different signal. BUILD.');
