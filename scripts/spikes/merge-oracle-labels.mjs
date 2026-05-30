// Combine multiple LLM-oracle relabel files into a single
// `.llm-labels.json` for the trainer to consume. Three merge
// strategies, picked via `--strategy`:
//
//   agreement   — keep only node ids where all oracles agree.
//                 Highest-precision but smallest dataset (drops
//                 anything ambiguous). Good when oracles are
//                 expensive but we want noise-free training data.
//
//   per-class   — for each class, use labels from the oracle that
//                 scored best on that class in val. Mapping is
//                 hardcoded below (`PER_CLASS_BEST_ORACLE`) based
//                 on the latest A/B numbers. When oracles disagree
//                 about a node's class, the winning oracle's label
//                 wins. This is the "best-of-best" play.
//
//   majority    — 2-of-N wins; ties drop the row. Robust against
//                 a single noisy oracle but loses signal when
//                 oracles meaningfully disagree.
//
//   union       — bag every label from every oracle. Where multiple
//                 oracles label the same node differently, the LAST
//                 file's label wins (file order matters). Mostly a
//                 baseline / sanity-check.
//
// Run from cartograph/:
//   npx tsx scripts/spikes/merge-oracle-labels.mjs \
//       --strategy per-class \
//       --inputs ~/.cache/cartograph/training-corpus/.llm-labels.qwen3coder.json,~/.cache/cartograph/training-corpus/.llm-labels.qwen36.json \
//       --out ~/.cache/cartograph/training-corpus/.llm-labels.json
//
// File aliases (--alias) — names attached to each input file for the
// per-class strategy table. Defaults match the filename roots:
//   `.llm-labels.qwen3coder.json` → `qwen3coder`
//   `.llm-labels.qwen36.json`     → `qwen36`
//   `.llm-labels.qwen3-2507.json` → `qwen3-2507`

import * as fs from 'node:fs';
import * as path from 'node:path';

const ARGS = process.argv.slice(2);
function getFlag(name, fallback) {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : fallback;
}

const STRATEGY = getFlag('strategy', 'per-class');
const INPUTS_RAW = getFlag('inputs', null);
if (!INPUTS_RAW) {
  console.error('--inputs is required (comma-separated paths)');
  process.exit(1);
}
const INPUTS = INPUTS_RAW.split(',').map((s) => s.trim()).filter(Boolean);
const OUT = getFlag('out', '.llm-labels.merged.json');
const ALIASES_RAW = getFlag('alias', null);

// Per-class winning oracle. Empirically derived from per-class
// recall in the val confusion matrices logged by the trainer.
// Update when running fresh A/Bs.
//
// Default policy: use Qwen3.6 as the main oracle (wins business_logic
// 97% vs Qwen3-Coder 85%, ties on data_model / api_endpoint / util /
// test_helper at ~99-100%, slightly conservative on `unknown`). Use
// Qwen3-Coder ONLY for framework_glue, where it has 80% recall vs
// Qwen3.6's 47%. This "main + gap-filler" pattern is what survived
// the empirical sweep (2026-05-10 night) — it bumped val accuracy
// past 94.3% (Qwen3.6 alone) without sacrificing framework_glue.
const PER_CLASS_BEST_ORACLE = {
  business_logic: 'qwen36',
  api_endpoint: 'qwen36',
  util: 'qwen36',
  data_model: 'qwen36',
  framework_glue: 'qwen3coder',  // ONLY class where Qwen3-Coder beats Qwen3.6
  test_helper: 'qwen36',
  unknown: 'qwen36',
};

// Resolve alias for each input. Default: filename root with leading
// dot/underscore stripped (e.g. ".llm-labels.qwen3coder.json" → "qwen3coder").
function defaultAlias(filePath) {
  const base = path.basename(filePath).replace(/^\.?llm-labels\./, '').replace(/\.json$/, '');
  return base || path.basename(filePath, '.json');
}

let aliases;
if (ALIASES_RAW) {
  aliases = ALIASES_RAW.split(',').map((s) => s.trim());
  if (aliases.length !== INPUTS.length) {
    console.error(`--alias count (${aliases.length}) must match --inputs count (${INPUTS.length})`);
    process.exit(1);
  }
} else {
  aliases = INPUTS.map(defaultAlias);
}

console.log(`Strategy: ${STRATEGY}`);
console.log('Inputs:');
for (let i = 0; i < INPUTS.length; i++) {
  console.log(`  ${aliases[i].padEnd(15)} ← ${INPUTS[i]}`);
}

// Load all input files into a `byOracle: Map<alias, Map<nodeKey, role>>`.
const byOracle = new Map();
for (let i = 0; i < INPUTS.length; i++) {
  const file = INPUTS[i].replace(/^~/, process.env.HOME || '~');
  if (!fs.existsSync(file)) {
    console.error(`Missing input: ${file}`);
    process.exit(1);
  }
  const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const labels = new Map(Object.entries(obj));
  byOracle.set(aliases[i], labels);
  console.log(`  ${aliases[i]}: ${labels.size} labels`);
}

// Build the union of node keys (so per-class can fall back to whatever
// oracle labeled a key when the preferred oracle didn't).
const allKeys = new Set();
for (const labels of byOracle.values()) {
  for (const key of labels.keys()) allKeys.add(key);
}
console.log(`\nUnion of node keys: ${allKeys.size}`);

const merged = {};
let kept = 0;
let droppedDisagree = 0;
let droppedTie = 0;

if (STRATEGY === 'agreement') {
  // Only keep keys all oracles agree on AND that ALL oracles labeled.
  for (const key of allKeys) {
    const labels = [];
    let allLabeled = true;
    for (const [, oracleLabels] of byOracle) {
      const lab = oracleLabels.get(key);
      if (!lab) { allLabeled = false; break; }
      labels.push(lab);
    }
    if (!allLabeled) continue;
    if (new Set(labels).size === 1) {
      merged[key] = labels[0];
      kept++;
    } else {
      droppedDisagree++;
    }
  }
} else if (STRATEGY === 'per-class') {
  // For each key, ask each oracle what class it predicts, then pick
  // the label from the oracle that's BEST for that predicted class.
  // Walk in priority order: try the canonical winner-oracle for each
  // class, fall back to any oracle that has the key.
  for (const key of allKeys) {
    // Pull every oracle's prediction for this key (if any).
    const preds = new Map();  // alias → role
    for (const [alias, oracleLabels] of byOracle) {
      const lab = oracleLabels.get(key);
      if (lab) preds.set(alias, lab);
    }
    // For each class an oracle predicts, ask "is this oracle the
    // canonical best for that class?" If yes, take that label.
    let chosen = null;
    for (const [alias, role] of preds) {
      if (PER_CLASS_BEST_ORACLE[role] === alias) {
        chosen = role;
        break;
      }
    }
    // Fallback: pick the FIRST oracle's label (input order).
    if (chosen === null) {
      const firstAlias = aliases.find((a) => preds.has(a));
      chosen = firstAlias ? preds.get(firstAlias) : null;
    }
    if (chosen) { merged[key] = chosen; kept++; }
  }
} else if (STRATEGY === 'majority') {
  for (const key of allKeys) {
    const counts = new Map();
    for (const [, oracleLabels] of byOracle) {
      const lab = oracleLabels.get(key);
      if (!lab) continue;
      counts.set(lab, (counts.get(lab) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    // Find max count + check for ties.
    let max = 0;
    let winners = [];
    for (const [role, n] of counts) {
      if (n > max) { max = n; winners = [role]; }
      else if (n === max) winners.push(role);
    }
    if (winners.length === 1) {
      merged[key] = winners[0];
      kept++;
    } else {
      droppedTie++;
    }
  }
} else if (STRATEGY === 'gap-fill') {
  // Take FIRST oracle's labels in full; for any class listed in
  // PER_CLASS_BEST_ORACLE that points to a LATER oracle, ADD that
  // oracle's labels for that class — but only for keys the first
  // oracle didn't already label. Never overrides the first oracle's
  // verdict; only fills holes.
  const primary = aliases[0];
  const primaryLabels = byOracle.get(primary);
  for (const [key, role] of primaryLabels) merged[key] = role;
  kept = primaryLabels.size;
  // For each class whose canonical oracle is NOT the primary, fill
  // gaps from the canonical oracle.
  for (const [role, canonicalAlias] of Object.entries(PER_CLASS_BEST_ORACLE)) {
    if (canonicalAlias === primary) continue;
    const canonicalLabels = byOracle.get(canonicalAlias);
    if (!canonicalLabels) continue;
    let added = 0;
    for (const [key, lab] of canonicalLabels) {
      if (lab !== role) continue;             // only the gap class
      if (primaryLabels.has(key)) continue;   // primary already spoke
      merged[key] = role;
      added++;
    }
    if (added > 0) console.log(`  gap-fill from ${canonicalAlias} for class ${role}: +${added}`);
    kept += added;
  }
} else if (STRATEGY === 'union') {
  // Just bag every label; later files overwrite earlier on conflict.
  for (const [, oracleLabels] of byOracle) {
    for (const [key, role] of oracleLabels) {
      merged[key] = role;
    }
  }
  kept = Object.keys(merged).length;
} else {
  console.error(`Unknown --strategy: ${STRATEGY}`);
  console.error('Pick from: agreement, per-class, majority, union');
  process.exit(1);
}

const outPath = OUT.replace(/^~/, process.env.HOME || '~');
fs.writeFileSync(outPath, JSON.stringify(merged));
console.log(`\nWrote ${outPath}`);
console.log(`  kept: ${kept}`);
if (STRATEGY === 'agreement') console.log(`  dropped (disagreed): ${droppedDisagree}`);
if (STRATEGY === 'majority') console.log(`  dropped (ties): ${droppedTie}`);

// Per-class distribution
const dist = new Map();
for (const role of Object.values(merged)) dist.set(role, (dist.get(role) ?? 0) + 1);
console.log('\nFinal distribution:');
const ROLES = ['business_logic', 'api_endpoint', 'util', 'data_model', 'framework_glue', 'test_helper', 'unknown'];
for (const r of ROLES) {
  console.log(`  ${r.padEnd(16)} ${String(dist.get(r) ?? 0).padStart(6)}`);
}
