#!/usr/bin/env node
// Aggregate per-run metrics (parse-run.mjs JSON sidecars) into median-per-arm
// rows + WITH→WITHOUT deltas, the way the published benchmark table wants them.
//
// Reads `*-run*.json` files under <dir> (recursively — works on a single
// corpus dir or a sweep root with one subdir per corpus). Medians (not means)
// per the fork's bench convention. Invalid runs (rate-limited / errored) are
// DROPPED and counted explicitly — never silently — so a throttled sweep is
// visible rather than smuggled into the medians.
//
// Usage: node aggregate.mjs <dir> [--out <results.json>] [--label <name>]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const root = args[0];
if (!root) {
  console.error('usage: aggregate.mjs <dir> [--out <json>] [--label <name>]');
  process.exit(2);
}
const outFile = argVal('--out');
const label = argVal('--label') || null;
function argVal(f) {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
}

// --- collect run jsons recursively ---
const runs = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/-run\d+\.json$/.test(e)) {
      try {
        runs.push(JSON.parse(readFileSync(p, 'utf8')));
      } catch {
        /* skip */
      }
    }
  }
})(root);

if (!runs.length) {
  console.error(`no *-run*.json metrics under ${root}`);
  process.exit(1);
}

// --- group by corpus → arm ---
const byCorpus = {};
for (const r of runs) {
  const c = r.corpus || '?';
  byCorpus[c] ??= { language: r.language || '?', with: [], without: [] };
  if (r.arm === 'with') byCorpus[c].with.push(r);
  else if (r.arm === 'without') byCorpus[c].without.push(r);
}

const median = (xs) => {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const tot = (r) => (r.tokensIn || 0) + (r.tokensOut || 0);
const valid = (rs) => rs.filter((r) => r.ok);

// Prefer the per-run boolean parse-run.mjs records; fall back to deriving it
// for run-jsons produced before cartographUsed existed.
const usedCg = (r) => r.cartographUsed ?? (r.fullCgCalls ?? r.cgCalls ?? 0) > 0;

function armMedians(rs) {
  const v = valid(rs);
  return {
    n: v.length,
    dropped: rs.length - v.length,
    // Valid runs in this arm that made ≥1 cartograph call. On the WITH arm,
    // cgUsedRuns < n means the agent had cartograph but ignored it on some run
    // (tool-choice variance) — surfaced, never dropped (dropping biases toward
    // cartograph). Trivially 0 for the WITHOUT arm (no cartograph available).
    cgUsedRuns: v.filter(usedCg).length,
    cost: median(v.map((r) => r.costUsd)),
    tokens: median(v.map(tot)),
    timeMs: median(v.map((r) => r.durationMs)),
    // toolCalls / cgCalls are the FULL count: the main agent's calls plus any
    // Explore sub-agent calls NOT already inlined into the main stream. Under
    // `claude -p --verbose` the sub-agent's calls ARE inlined (same tool_use
    // ids), so full === main — parse-run.mjs de-duplicates by id rather than
    // summing (which would double-count delegated calls). `?? r.totalCalls`
    // falls back to main-only for run-jsons produced before fullCalls existed.
    toolCalls: median(v.map((r) => r.fullCalls ?? r.totalCalls)),
    cgCalls: median(v.map((r) => r.fullCgCalls ?? r.cgCalls)),
    mainToolCalls: median(v.map((r) => r.totalCalls)),
    subCalls: median(v.map((r) => r.subCalls)),
    // Sub-agent calls NOT already inlined into the main stream. Expected ~0
    // under current claude (--verbose inlines them); a non-zero median is the
    // canary that a future claude stopped inlining and full=main+sub kicked in.
    subDistinctCalls: median(v.map((r) => r.subDistinctCalls)),
    subTranscripts: median(v.map((r) => r.subagentTranscripts)),
    reads: median(v.map((r) => r.fullReadCalls ?? r.readCalls)),
    greps: median(v.map((r) => r.fullGrepCalls ?? r.grepCalls)),
    taskSpawns: median(v.map((r) => r.taskSpawns)),
    exploreSpawns: median(v.map((r) => r.exploreSpawns)),
  };
}
const pct = (w, wo) => (w == null || wo == null || wo === 0 ? null : Math.round(((wo - w) / wo) * 100));

const rows = [];
for (const [corpus, g] of Object.entries(byCorpus).sort()) {
  const w = armMedians(g.with),
    wo = armMedians(g.without);
  rows.push({
    corpus,
    language: g.language,
    with: w,
    without: wo,
    savings: {
      cost: pct(w.cost, wo.cost),
      tokens: pct(w.tokens, wo.tokens),
      time: pct(w.timeMs, wo.timeMs),
      toolCalls: pct(w.toolCalls, wo.toolCalls),
    },
  });
}

// --- overall averages of the per-corpus savings (only where defined) ---
const avg = (key) => {
  const xs = rows.map((r) => r.savings[key]).filter((x) => x != null);
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
};
const overall = { cost: avg('cost'), tokens: avg('tokens'), time: avg('time'), toolCalls: avg('toolCalls') };

// --- WITH-arm cartograph adoption: how often the agent actually engaged
// cartograph when it was available. A 0-cartograph WITH run measures
// tool-choice variance, not cartograph's value — it stays in the medians
// (dropping it would bias the WITH arm toward cartograph), but it's surfaced
// here so a low adoption rate (or an n=1 fluke) is never invisible. ---
const adoption = {
  withUsed: rows.reduce((a, r) => a + r.with.cgUsedRuns, 0),
  withTotal: rows.reduce((a, r) => a + r.with.n, 0),
  // without-arm runs that made ≥1 cartograph call — should always be 0. Non-zero
  // = an isolation/steer leak: the agent ATTEMPTED cartograph in the no-cartograph
  // arm (the global CLAUDE.md recommends it), the calls error, and they inflate
  // the without-arm tool-call count. Surfaced loudly below.
  withoutAttempted: rows.reduce((a, r) => a + r.without.cgUsedRuns, 0),
};

// --- console report ---
const fmtMs = (ms) =>
  ms == null
    ? '?'
    : ms >= 60000
      ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
      : `${(ms / 1000).toFixed(0)}s`;
const fmt$ = (c) => (c == null ? '?' : `$${c.toFixed(3)}`);
const fmtK = (t) => (t == null ? '?' : t >= 1000 ? `${(t / 1000).toFixed(0)}k` : `${t}`);
const sv = (p) => (p == null ? '?' : `${p}%`).padStart(5); // savings %, positive = cartograph cheaper/fewer/faster

console.log(`\n=== agent-eval aggregate${label ? ` [${label}]` : ''} — ${rows.length} corpora ===\n`);
console.log(
  'corpus            lang     | cost  WITH→WITHOUT        | tokens WITH→WITHOUT   | time WITH→WITHOUT     | calls WITH→WITHOUT*  | dropped',
);
// Whether ANY individual run recovered a sub-agent transcript — checked on the
// raw runs, not the median (a median subTranscripts of 0 is falsy even when
// some runs found sub-agents and folded them into fullCalls).
const sawSubagents = runs.some((r) => (r.subagentTranscripts ?? 0) > 0);
for (const r of rows) {
  const d = r.with.dropped + r.without.dropped || 0;
  console.log(
    `${r.corpus.padEnd(17)} ${r.language.padEnd(8)} | ` +
      `${fmt$(r.with.cost)}→${fmt$(r.without.cost)} (${sv(r.savings.cost)}) | ` +
      `${fmtK(r.with.tokens)}→${fmtK(r.without.tokens)} (${sv(r.savings.tokens)}) | ` +
      `${fmtMs(r.with.timeMs)}→${fmtMs(r.without.timeMs)} (${sv(r.savings.time)}) | ` +
      `${r.with.toolCalls}→${r.without.toolCalls} (${sv(r.savings.toolCalls)}) | ${d}`,
  );
}
console.log(
  `\nAVERAGE SAVINGS: cost ${overall.cost}% · tokens ${overall.tokens}% · time ${overall.time}% · tool-calls ${overall.toolCalls}%`,
);
console.log('(positive = cartograph is cheaper/fewer/faster. "dropped" = runs excluded as rate-limited/errored.)');
console.log(
  sawSubagents
    ? "* calls = FULL true total: the main stream already inlines the Explore sub-agent's calls (claude --verbose), de-duplicated by tool_use id — NOT main+sub summed (that double-counted). Per-arm main / raw-sub medians are in results.json (mainToolCalls / subCalls / subTranscripts). NOTE: tokens ARE main-thread-only (result.usage excludes sub-agents) — a lower bound when the agent delegates."
    : '* calls = main-agent only (no sub-agent transcripts found for these runs).',
);

const totalDropped = rows.reduce((a, r) => a + r.with.dropped + r.without.dropped, 0);
if (totalDropped)
  console.log(
    `\n⚠ ${totalDropped} run(s) dropped across the sweep — medians computed on the survivors. Re-run the affected corpora for full N.`,
  );

console.log(
  `\ncartograph adoption: agent used cartograph in ${adoption.withUsed}/${adoption.withTotal} with-arm runs.`,
);
const cgUnused = rows.filter((r) => r.with.cgUsedRuns < r.with.n);
if (cgUnused.length)
  console.log(
    `⚠ ${adoption.withTotal - adoption.withUsed} with-arm run(s) skipped cartograph (available, but the agent didn't use it on that run): ${cgUnused
      .map((r) => `${r.corpus} ${r.with.cgUsedRuns}/${r.with.n}`)
      .join(
        ', ',
      )}. KEPT in the medians (they measure tool-choice variance, not cartograph) — raise N or investigate if the rate is high.`,
  );
const withoutLeaked = rows.filter((r) => r.without.cgUsedRuns > 0);
if (withoutLeaked.length)
  console.log(
    `⚠ ISOLATION/STEER LEAK: ${withoutLeaked
      .map((r) => `${r.corpus} ${r.without.cgUsedRuns}/${r.without.n}`)
      .join(
        ', ',
      )} — without-arm run(s) ATTEMPTED cartograph (the global CLAUDE.md recommends it; calls error since the without arm has no cartograph MCP). They inflate the without-arm tool-call count on affected runs — check those medians aren't skewed, or isolate the eval from the global CLAUDE.md.`,
  );

const report = { label, corpora: rows.length, overall, adoption, rows };
if (outFile) {
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`); // trailing newline keeps committed results biome-clean
  console.log(`\n→ ${outFile}`);
}
