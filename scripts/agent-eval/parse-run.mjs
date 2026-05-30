#!/usr/bin/env node
// Parse a Claude Code `claude -p --output-format stream-json` run log into a
// machine-readable metrics object (for aggregate.mjs) plus a human summary.
//
// Ported from upstream colbymchenry/codegraph scripts/agent-eval/parse-run.mjs
// (commit a6183d7c) and extended for this fork with:
//   - per-tool-result OUTPUT SIZE measurement (the "load-bearing" signal:
//     how many bytes each cartograph call vs Read/Grep returned into context)
//   - subagent (Task/Explore) delegation tallying — central to the
//     answer-directly-vs-delegate question this fork's eval cares about
//   - a `--json <path>` sidecar emit so aggregate.mjs can take medians
//
// Usage: node parse-run.mjs <run.jsonl> [--json <out.json>] [--meta k=v,k=v]
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('usage: parse-run.mjs <run.jsonl> [--json <out>] [--meta k=v]');
  process.exit(2);
}
const jsonOut = argVal('--json');
const meta = parseMeta(argVal('--meta'));

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function parseMeta(s) {
  const m = {};
  if (!s) return m;
  for (const kv of s.split(',')) {
    const [k, ...v] = kv.split('=');
    if (k) m[k] = v.join('=');
  }
  return m;
}

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

// The sub-agent-spawn tool is named `Task` in some Claude Code builds and
// `Agent` in others (2.1.156 uses `Agent`) — count both.
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

const calls = []; // { id, name, label, outBytes, subagent }
let result = null;
let initTools = null;
let errored = false;
let rateLimited = false;
// Captured from the init/result events; used to locate the on-disk session
// transcript and its subagent transcripts (see tallySubagents).
let sessionId = null;

for (const line of lines) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }

  if (ev.session_id) sessionId = ev.session_id;

  if (ev.type === 'system' && ev.subtype === 'init') {
    initTools = (ev.tools || []).filter((t) => /cartograph/.test(t));
  }

  if (ev.type === 'assistant' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        let label = '';
        if (SUBAGENT_TOOLS.has(block.name))
          label = ` [subagent=${block.input?.subagent_type ?? 'general'}] ${(block.input?.description ?? '').slice(0, 40)}`;
        else if (/cartograph/.test(block.name))
          label = ` ${JSON.stringify(block.input?.query ?? block.input?.task ?? block.input?.symbol ?? block.input?.by ?? '').slice(0, 60)}`;
        else if (block.name === 'Bash') label = ` ${(block.input?.command ?? '').slice(0, 50)}`;
        else if (block.name === 'Read') label = ` ${(block.input?.file_path ?? '').split('/').slice(-1)[0]}`;
        calls.push({ id: block.id, name: block.name, label, outBytes: 0, subagent: block.input?.subagent_type });
      }
    }
  }

  // tool_result blocks arrive as `user` events; match them back to the call
  // to measure how many bytes the tool dumped into context (the size signal).
  if (ev.type === 'user' && ev.message?.content) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '';
      const call = calls.find((k) => k.id === b.tool_use_id);
      if (call) call.outBytes = txt.length;
    }
  }

  if (ev.type === 'result') {
    result = ev;
    if ((ev.subtype && ev.subtype !== 'success') || ev.is_error) errored = true;
    // Only scan for a rate-limit signal on a FAILED run. On success, ev.result
    // is the agent's answer text — scanning it for "rate"/"limit"/"usage" would
    // false-positive whenever the answer mentions a rate limiter, usage, etc.
    if (errored) {
      const errText = `${ev.error || ''} ${ev.subtype || ''} ${typeof ev.result === 'string' ? ev.result : ''}`;
      if (/rate.?limit|overload|\b429\b|too many requests|quota|exceeded your/i.test(errText)) rateLimited = true;
    }
  }
}

// --- subagent transcripts (measure sub-context bytes + recover any calls the
// main stream genuinely misses) ---
// When the agent delegates to an Explore sub-agent, Claude Code writes that
// sub-agent's full transcript to
// ~/.claude/projects/<project>/<session>/subagents/*.jsonl. We locate it by
// SESSION ID (a globally unique UUID) rather than reconstructing Claude Code's
// path-escaping — robust to whatever escaping rule it uses (it dash-collapses
// `.`, etc.).
//
// IMPORTANT (verified 2026-05-29, claude 2.1.157): `claude -p --verbose`
// already INLINES every sub-agent tool_use block into the MAIN stream-json,
// with the SAME globally-unique tool_use id. So the main `calls` array is a
// complete superset — counting the sub-agent transcript's calls again would
// DOUBLE-COUNT every delegated call (the pre-2026-05-29 bug: fullCalls was ~2×
// the truth on delegated runs). We therefore tally the transcript but only
// add ids NOT already present in the main stream to the `distinct*` counters
// that feed `fullCalls`. Under the current inlining behaviour distinct* is 0
// and full === main (the honest true total); if a future claude build stops
// inlining, those ids won't be in mainIds and DO get counted — so
// `full = main + genuinely-distinct sub` in either regime. The raw `calls`
// counter is kept for the informational "the sub-agent did N calls" line.
const isCgName = (n) => /cartograph/.test(n);

/**
 * Tally a single transcript's tool_use names + tool_result bytes into `acc`.
 * `mainIds` is the set of tool_use ids already seen in the main stream; calls
 * whose id is in it are counted into the raw totals but NOT the `distinct*`
 * totals, so they don't double-count against `fullCalls`.
 */
function tallyTranscript(file, acc, mainIds) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') {
        const cg = isCgName(b.name);
        const rd = b.name === 'Read';
        const gp = b.name === 'Grep' || b.name === 'Glob';
        acc.calls++;
        if (cg) acc.cgCalls++;
        else if (rd) acc.readCalls++;
        else if (gp) acc.grepCalls++;
        if (!mainIds.has(b.id)) {
          acc.distinctCalls++;
          if (cg) acc.distinctCgCalls++;
          else if (rd) acc.distinctReadCalls++;
          else if (gp) acc.distinctGrepCalls++;
        }
      } else if (b.type === 'tool_result') {
        const c = b.content;
        acc.outBytes +=
          typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, x) => a + (x?.text?.length || 0), 0) : 0;
      }
    }
  }
}

/**
 * Find the session transcript for `id` under ~/.claude/projects and tally
 * every sub-agent transcript beside it. Returns null when the session can't
 * be located (no id, or transcripts not on disk — e.g. a future Claude Code
 * that stores them elsewhere), so the metrics degrade to main-only cleanly.
 */
function tallySubagents(id, mainIds) {
  if (!id) return null;
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projectsRoot = join(base, 'projects');
  if (!existsSync(projectsRoot)) return null;
  let projDir = null;
  for (const d of readdirSync(projectsRoot)) {
    const p = join(projectsRoot, d);
    try {
      if (statSync(p).isDirectory() && existsSync(join(p, `${id}.jsonl`))) {
        projDir = p;
        break;
      }
    } catch {
      /* unreadable entry — skip */
    }
  }
  if (!projDir) return null;
  const acc = {
    transcripts: 0,
    calls: 0,
    cgCalls: 0,
    readCalls: 0,
    grepCalls: 0,
    distinctCalls: 0,
    distinctCgCalls: 0,
    distinctReadCalls: 0,
    distinctGrepCalls: 0,
    outBytes: 0,
  };
  const subDir = join(projDir, id, 'subagents');
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((f) => f.endsWith('.jsonl'))) {
      acc.transcripts++;
      tallyTranscript(join(subDir, f), acc, mainIds);
    }
  }
  return acc;
}

const sub = tallySubagents(sessionId, new Set(calls.map((c) => c.id)));

// --- categorise ---
const isCg = (n) => /cartograph/.test(n);
const sumBytes = (pred) => calls.filter((c) => pred(c.name)).reduce((a, c) => a + c.outBytes, 0);
const countBy = {};
for (const c of calls) countBy[c.name] = (countBy[c.name] || 0) + 1;

const cgCalls = calls.filter((c) => isCg(c.name)).length;
const readCalls = calls.filter((c) => c.name === 'Read').length;
const grepCalls = calls.filter((c) => c.name === 'Grep' || c.name === 'Glob').length;
const taskSpawns = calls.filter((c) => SUBAGENT_TOOLS.has(c.name));
const exploreSpawns = taskSpawns.filter((c) => /explore/i.test(`${c.subagent || ''} ${c.label || ''}`)).length;

// IMPORTANT: `result.usage` is MAIN-THREAD-ONLY for TOKENS. Verified
// empirically (2026-05-28): a run that delegated had
// result.usage.output_tokens=3364 while its sub-agent transcript summed 7388
// output tokens — and output is never cached, so result.usage cannot include
// the sub-agent's. So when the agent delegates, tokensIn/tokensOut are a lower
// bound on the run's true token use. (Note the contrast with TOOL CALLS, which
// `--verbose` DOES inline into the main stream — see fullCalls above; tokens
// are not inlined into result.usage the same way.) `costUsd`
// (result.total_cost_usd) is the run's reported invocation-level figure;
// whether IT folds in sub-agent billing is not independently confirmed here.
// Re-verify all three against the `claude` CLI changelog on upgrade.
const u = result?.usage || {};
const tokensIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const tokensFresh = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const tokensCached = u.cache_read_input_tokens || 0;
const tokensOut = u.output_tokens || 0;

const metrics = {
  file: file.split('/').pop(),
  ...meta, // corpus, arm, run, language injected by caller
  ok: !!result && !errored && !rateLimited,
  rateLimited,
  errored,
  subtype: result?.subtype ?? null,
  sessionId,
  cartographToolsExposed: initTools ? initTools.length : null,
  // Main-thread counts (what the stream-json directly observes).
  totalCalls: calls.length,
  cgCalls,
  readCalls,
  grepCalls,
  taskSpawns: taskSpawns.length,
  exploreSpawns,
  // Sub-agent counts recovered from the on-disk transcripts. null when the
  // session couldn't be located (degrade to main-only). NOTE: under `--verbose`
  // inlining (see fullCalls), subOutBytes is the RAW sub-transcript byte sum,
  // which also appears in totalOutBytes (the inlined results land in main too) —
  // it's an informational "how much the Explore sub-agent absorbed" stat, not a
  // main-context figure, and is kept separate from cgOutBytes/readOutBytes.
  subagentTranscripts: sub?.transcripts ?? null,
  // Raw sub-agent counts — these INCLUDE calls already inlined into the main
  // stream by `--verbose`, so they're informational ("the Explore sub-agent
  // ran N calls"), not additive. The additive figure is subDistinctCalls.
  subCalls: sub?.calls ?? null,
  subCgCalls: sub?.cgCalls ?? null,
  subReadCalls: sub?.readCalls ?? null,
  subGrepCalls: sub?.grepCalls ?? null,
  subDistinctCalls: sub?.distinctCalls ?? null,
  subOutBytes: sub?.outBytes ?? null,
  // Full = main + sub-agent calls NOT already in the main stream. Under
  // `claude -p --verbose` the sub-agent's calls are inlined into the main
  // stream (same tool_use ids), so distinct* is 0 and full === main — the
  // honest true total with no double-count. (Pre-2026-05-29 this summed the
  // RAW sub counts and double-counted every delegated call.) When no sub-agent
  // transcript is found, full === main.
  fullCalls: calls.length + (sub?.distinctCalls ?? 0),
  fullCgCalls: cgCalls + (sub?.distinctCgCalls ?? 0),
  fullReadCalls: readCalls + (sub?.distinctReadCalls ?? 0),
  fullGrepCalls: grepCalls + (sub?.distinctGrepCalls ?? 0),
  // True iff the run made ≥1 cartograph call. On a `with`-arm run, false means
  // the agent had cartograph available but didn't reach for it — a tool-choice
  // variance data point that aggregate.mjs flags + counts (never silently
  // drops, which would cherry-pick the WITH arm toward cartograph).
  cartographUsed: cgCalls + (sub?.distinctCgCalls ?? 0) > 0,
  countByType: countBy,
  cgOutBytes: sumBytes(isCg),
  readOutBytes: sumBytes((n) => n === 'Read'),
  grepOutBytes: sumBytes((n) => n === 'Grep' || n === 'Glob'),
  totalOutBytes: calls.reduce((a, c) => a + c.outBytes, 0),
  durationMs: result?.duration_ms ?? null,
  numTurns: result?.num_turns ?? null,
  tokensIn,
  tokensFresh,
  tokensCached,
  tokensOut,
  costUsd: result?.total_cost_usd ?? null, // API-equivalent figure; on a Max plan this is accounting, not a charge
};

// --- human summary ---
console.log(`\n=== ${metrics.file}${meta.arm ? ` [${meta.arm}]` : ''}${meta.run ? ` run${meta.run}` : ''} ===`);
console.log(`cartograph tools exposed: ${metrics.cartographToolsExposed ?? '?'}`);
if (rateLimited) console.log('  ⚠ RATE-LIMITED / usage signal in result — treat as invalid, retry');
if (errored) console.log(`  ⚠ result subtype: ${metrics.subtype}`);
console.log(
  `tool calls (${calls.length}): cg=${cgCalls} read=${readCalls} grep=${grepCalls} task=${taskSpawns.length}(explore=${exploreSpawns})`,
);
if (sub) {
  const inlined = sub.calls - sub.distinctCalls;
  console.log(
    `  + subagents (${sub.transcripts} transcript${sub.transcripts === 1 ? '' : 's'}): ` +
      `${sub.calls} calls (cg=${sub.cgCalls} read=${sub.readCalls} grep=${sub.grepCalls}), ${kb(sub.outBytes)} into sub-context` +
      (inlined ? ` [${inlined} already inlined into main stream — not double-counted]` : ''),
  );
  console.log(
    `  = FULL (main + ${sub.distinctCalls} distinct sub): ${metrics.fullCalls} calls (cg=${metrics.fullCgCalls})`,
  );
} else {
  console.log(`  (no sub-agent transcript located for session ${sessionId ?? '?'} — counts are main-only)`);
}
console.log('  by type:', JSON.stringify(countBy));
console.log(
  `  out bytes: cg=${kb(metrics.cgOutBytes)} read=${kb(metrics.readOutBytes)} grep=${kb(metrics.grepOutBytes)} total=${kb(metrics.totalOutBytes)}`,
);
calls.forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.name}${c.label}${c.outBytes ? `  (${kb(c.outBytes)})` : ''}`);
});
if (result) {
  console.log(`\nResult: ${result.subtype} | duration ${fmtSec(result.duration_ms)} | turns ${result.num_turns}`);
  console.log(
    `  tokens: in=${tokensIn} (fresh=${tokensFresh} cached=${tokensCached}) out=${tokensOut} | cost $${(result.total_cost_usd || 0).toFixed(3)} (API-equiv)`,
  );
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(`  → ${jsonOut}`);
}

function kb(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}
function fmtSec(ms) {
  return ms == null ? '?' : `${(ms / 1000).toFixed(0)}s`;
}
