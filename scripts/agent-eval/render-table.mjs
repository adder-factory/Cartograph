#!/usr/bin/env node
// Render an aggregate results.json (from aggregate.mjs) into the README
// benchmark markdown: a summary savings table, a collapsible WITH→WITHOUT
// raw-medians table, and the one-line headline — matching the upstream
// README shape (| Codebase | Language | Cost | Tokens | Time | Tool calls |).
//
// Usage: node render-table.mjs <results.json> [--stamp "<provenance line>"]
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('usage: render-table.mjs <results.json> [--stamp "<line>"]');
  process.exit(2);
}
const stampIdx = args.indexOf('--stamp');
const stamp = stampIdx >= 0 ? args[stampIdx + 1] : '';
const r = JSON.parse(readFileSync(file, 'utf8'));

const fmt$ = (c) => (c == null ? '—' : `$${c.toFixed(2)}`);
const fmtK = (t) =>
  t == null ? '—' : t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`;
const fmtT = (ms) =>
  ms == null
    ? '—'
    : ms >= 60000
      ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
      : `${(ms / 1000).toFixed(0)}s`;
const sav = (p, word) => (p == null ? '—' : p >= 0 ? `**${p}% ${word.less}**` : `${-p}% ${word.more}`);
const W = {
  cost: { less: 'cheaper', more: 'pricier' },
  tokens: { less: 'fewer', more: 'more' },
  time: { less: 'faster', more: 'slower' },
  toolCalls: { less: 'fewer', more: 'more' },
};

const o = r.overall;
const headline = `${o.cost ?? '—'}% cheaper · ${o.tokens ?? '—'}% fewer tokens · ${o.time ?? '—'}% faster · ${o.toolCalls ?? '—'}% fewer tool calls`;
// Nominal attempted run count per arm = max(survivors + dropped) across all
// arms — so the methodology sentence stays honest whether this is an n=1
// refresh or a full median-of-4 sweep (per-row drops are noted separately).
const nominalRuns = Math.max(
  1,
  ...r.rows.flatMap((row) => [row.with.n + (row.with.dropped || 0), row.without.n + (row.without.dropped || 0)]),
);

let out = `### Benchmark Results\n\n`;
out += `Tested across ${r.corpora} real-world OSS codebases, comparing a headless \`claude -p\` agent **with** and **without** Cartograph's MCP — cartograph is the only variable.\n\n`;
out += `> **Average: ${headline}**\n\n`;
out += `| Codebase | Language | Cost | Tokens | Time | Tool calls |\n|---|---|---|---|---|---|\n`;
for (const row of r.rows) {
  out += `| **${row.corpus}** | ${row.language} | ${sav(row.savings.cost, W.cost)} | ${sav(row.savings.tokens, W.tokens)} | ${sav(row.savings.time, W.time)} | ${sav(row.savings.toolCalls, W.toolCalls)} |\n`;
}

out += `\n<details>\n<summary><strong>Full benchmark details</strong></summary>\n\n`;
out += stamp ? `${stamp}\n\n` : '';
out += `Methodology: each arm is \`claude -p\` (Claude Opus) run headlessly with \`--strict-mcp-config\`. **With** = Cartograph MCP enabled; **without** = empty MCP config; built-in Read/Grep/Bash available to both — so Cartograph is the only variable. Same question per repo, median of ${nominalRuns} run${nominalRuns === 1 ? '' : 's'} per arm, natural agent behavior — no eval-specific steering prompt, though both arms inherit the user's standard global config (which recommends cartograph when a \`.cartograph\` index is present, as a real install has). Cost = \`total_cost_usd\` (API-equivalent — on a Max subscription this is accounting, not billing); Tokens = input incl. cached + output; Time = wall-clock. **Tool calls** is the true total — it includes every call the agent's Explore sub-agent makes: \`claude -p --verbose\` inlines a delegated sub-agent's tool calls into the main transcript (same tool_use ids), so the count is already complete (the harness de-duplicates by id to avoid double-counting). **Tokens**, by contrast, are main-thread-only: \`claude\`'s \`result.usage\` excludes a delegated sub-agent's token use, so when the agent delegates the token figure is a conservative lower bound. The clearest, lowest-variance win is tool-call reduction (fewer discovery round-trips); cost/tokens are closer because \`cartograph_explore\` returns large rich context that offsets the file-read savings.\n\n`;
if (r.adoption && r.adoption.withTotal)
  out += `With cartograph available, the agent engaged it in **${r.adoption.withUsed} of ${r.adoption.withTotal}** \`with\`-arm runs. A run that ignores an available cartograph measures tool-choice variance, not cartograph's value; such runs are flagged and kept in the medians (never dropped — dropping would bias the result toward cartograph).\n\n`;
out += `**Raw medians — WITH → WITHOUT:**\n\n`;
out += `| Codebase | Cost | Tokens | Time | Tool calls |\n|---|---|---|---|---|\n`;
for (const row of r.rows) {
  const w = row.with,
    wo = row.without;
  out += `| ${row.corpus} | ${fmt$(w.cost)} → ${fmt$(wo.cost)} | ${fmtK(w.tokens)} → ${fmtK(wo.tokens)} | ${fmtT(w.timeMs)} → ${fmtT(wo.timeMs)} | ${w.toolCalls} → ${wo.toolCalls} |\n`;
}
const totalDropped = r.rows.reduce((a, x) => a + (x.with.dropped || 0) + (x.without.dropped || 0), 0);
if (totalDropped)
  out += `\n_${totalDropped} run(s) excluded as rate-limited/errored; medians taken on the survivors._\n`;
out += `\n</details>\n`;

process.stdout.write(out);
process.stderr.write(`\nheadline for the README badge line:\n  ${headline}\n`);
