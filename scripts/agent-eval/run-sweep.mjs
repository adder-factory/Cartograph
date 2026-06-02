#!/usr/bin/env node
// Serial sweep driver: select corpora from corpus.json, run the A/B for each
// (run-ab.sh), then aggregate medians (aggregate.mjs). Serial by design — the
// eval `claude -p` runs draw from the same Max account as the live session, so
// concurrency would only hit the rate limit faster. On a detected rate-limit
// the affected corpus is backed off and retried once.
//
// Usage:
//   node run-sweep.mjs --tier small [--runs 1] [--model opus] [--label shakedown]
//   node run-sweep.mjs --publish --runs 4 --label publish-<date>
//   node run-sweep.mjs --corpora gin,nest,ktor --runs 2
//   node run-sweep.mjs --all --runs 4
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};

const cfg = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'));
const corpusRoot = (process.env.CORPUS_ROOT || cfg.corpusRoot).replace(/^~/, homedir());

// --- selection ---
let chosen = cfg.corpora;
if (has('--publish')) chosen = chosen.filter((c) => c.publish);
else if (has('--tier')) {
  const t = val('--tier');
  chosen = chosen.filter((c) => c.tier === t);
} else if (has('--corpora')) {
  const set = new Set(val('--corpora').split(','));
  chosen = chosen.filter((c) => set.has(c.name));
} else if (!has('--all')) {
  console.error('select corpora: --all | --publish | --tier <t> | --corpora a,b,c');
  process.exit(2);
}

const RUNS = val('--runs', '1');
const MODEL = val('--model', 'opus');
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
const LABEL = val('--label', `sweep-${stamp}`);
const SWEEP_OUT = join(process.env.AGENT_EVAL_OUT || '/tmp/agent-eval', LABEL);
const RL_BACKOFF_S = Number(process.env.RL_BACKOFF_S || 120);
mkdirSync(SWEEP_OUT, { recursive: true });

if (!chosen.length) {
  console.error('no corpora matched the selector');
  process.exit(1);
}
console.log(`\n###### sweep "${LABEL}": ${chosen.length} corpora × ${RUNS} runs × {with,without}, model=${MODEL}`);
const chosenLines = chosen.map((c) => `   - ${c.name} (${c.language}, ${c.tier})`).join('\n');
console.log(`###### out: ${SWEEP_OUT}\n${chosenLines}\n`);

const sleep = (s) => execFileSync('sleep', [String(s)]);
const corpusRateLimited = (name) => {
  const dir = join(SWEEP_OUT, name);
  try {
    return readdirSync(dir)
      .filter((f) => /-run\d+\.json$/.test(f))
      .some((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf8')).rateLimited;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
};

function runCorpus(c) {
  const path = join(corpusRoot, c.name);
  console.log(`\n========================= ${c.name} (${c.language}) =========================`);
  try {
    execFileSync('bash', [join(HERE, 'run-ab.sh'), path, c.question, c.name, RUNS, MODEL], {
      stdio: 'inherit',
      env: { ...process.env, AGENT_EVAL_OUT: SWEEP_OUT, CORPUS_LANG: c.language },
    });
  } catch (e) {
    console.log(`[run-ab exited non-zero for ${c.name} — continuing] ${e.message?.split('\n')[0] || ''}`);
  }
}

for (const c of chosen) {
  runCorpus(c);
  if (corpusRateLimited(c.name)) {
    console.log(`\n⚠ rate-limit detected on ${c.name} — backing off ${RL_BACKOFF_S}s then retrying once`);
    sleep(RL_BACKOFF_S);
    runCorpus(c);
  }
}

// --- aggregate ---
console.log('\n========================= AGGREGATE =========================');
const resultsJson = join(SWEEP_OUT, 'results.json');
execFileSync('node', [join(HERE, 'aggregate.mjs'), SWEEP_OUT, '--out', resultsJson, '--label', LABEL], {
  stdio: 'inherit',
});
console.log(`\n###### sweep complete → ${resultsJson}`);
