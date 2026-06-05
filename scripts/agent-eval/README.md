# scripts/agent-eval/

Headless **agent-behavior** eval for cartograph's MCP surface. Unlike `bench/`
(internal perf micro-benchmarks) and `__tests__/evaluation/` (in-process
retrieval-ranking gate), this harness spawns **real `claude -p` agent runs** and
measures how an agent's behavior changes _with_ vs _without_ cartograph: cost,
tokens, wall-clock, tool-call count, and — the decisive signal — how many bytes
each tool dumped into context and how often the agent fell back to
Read/Grep/Explore-subagent delegation.

Ported from the upstream project eval harness noted in
[`ACKNOWLEDGEMENTS.md`](../../ACKNOWLEDGEMENTS.md) (commit `a6183d7c`) and
adapted for Cartograph: no global `cartograph` binary (the MCP server is
`bun src/bin/cartograph.ts`), the serve flag is `--project-path`, and the sweep
takes a **median of N runs** rather than a single run.

## The A/B

Cartograph is the **only** variable. Both arms launch `claude -p` with
`--strict-mcp-config`, so only the MCP config passed in is active:

- **with** — `{"mcpServers":{"cartograph":{"command":"bun","args":[".../src/bin/cartograph.ts","serve","--mcp","--project-path","<corpus>"]}}}`
- **without** — `{"mcpServers":{}}`

Built-in Read/Grep/Bash stay available in **both** arms, so the delta isolates
cartograph's contribution rather than measuring "tools vs no tools."

## Running

```bash
# shakedown — prove the pipeline on the small corpora, 1 run each
node scripts/agent-eval/run-sweep.mjs --tier small --runs 1 --label shakedown

# the published B5 set — 7 languages, median of 4
node scripts/agent-eval/run-sweep.mjs --publish --runs 4 --label publish-2026-05-28

# a hand-picked subset
node scripts/agent-eval/run-sweep.mjs --corpora gin,nest,ktor --runs 2

# one corpus directly (path + question), 2 runs
bash scripts/agent-eval/run-ab.sh ~/.cache/cartograph/training-corpus/gin "How does Gin route a request?" gin 2

# re-aggregate an existing output dir into a results.json
node scripts/agent-eval/aggregate.mjs /tmp/agent-eval/publish-2026-05-28 --out results.json --label publish
```

Corpora and their flow-questions live in `corpus.json` (15 pre-indexed repos
under `~/.cache/cartograph/training-corpus/`). `publish: true` marks the
7-language README set.

> **Serial by design.** The eval runs draw from the same Max-plan account as the
> live session, so the sweep is strictly serial; concurrency would only hit the
> rate limit faster. On a Max subscription the `total_cost_usd` numbers are
> **API-equivalent accounting figures, not charges** — the real constraint is
> the usage window. A detected rate-limit backs the corpus off and retries once.

## Env overrides

| Var | Default | Effect |
|---|---|---|
| `CORPUS_ROOT` | `~/.cache/cartograph/training-corpus` | Where the indexed corpora live (overrides `corpus.json`'s `corpusRoot`). |
| `AGENT_EVAL_OUT` | `/tmp/agent-eval` | Output root. `run-sweep.mjs` writes to `$AGENT_EVAL_OUT/<label>/<corpus>/`. |
| `BUN_BIN` | `$(command -v bun)` | bun binary embedded in the generated `with`-arm MCP config. |
| `CG_ENTRY` | `<repo>/src/bin/cartograph.ts` | cartograph serve entrypoint. |
| `MAX_BUDGET_USD` | `4` | Per-run hard cap passed to `claude --max-budget-usd` (safety stop). |
| `RUN_SLEEP_S` | `3` | Sleep between individual runs. |
| `RL_BACKOFF_S` | `120` | Backoff before the single retry when a corpus run is rate-limited. |
| `EVAL_NO_DELEGATE` | `0` | `0` = natural agent behavior (delegates to an Explore sub-agent per the host CLAUDE.md) — **the representative, published mode**, since that's how Cartograph is actually used and where its value shows. `1` appends a single-agent steering prompt to both arms (no delegation) so every tool call is observable — useful for debugging / A/B-ing steering, but it suppresses the delegation pattern Cartograph is built around and **undersells** it, so not for publishing. |

> **Delegation vs. single-agent.** In the default (natural) mode the agent may spawn an Explore sub-agent in either arm. The stream-json stream only records the main thread (one `Agent` spawn), so `parse-run.mjs` ALSO reads the run's on-disk session transcript and its `subagents/*.jsonl` siblings — located by the run's `session_id` (a unique UUID, so no path-escaping guesswork) — and folds the sub-agent's internal tool calls into the metrics. `totalCalls`/`cgCalls` stay main-only; `subCalls`/`subCgCalls`/`subagentTranscripts` are the recovered sub-agent counts; `fullCalls`/`fullCgCalls` are the honest main+sub totals (what `aggregate.mjs` reports as the tool-call delta). **Tokens/cost are NOT summed across sub-agents.** `result.usage` is main-thread-only — verified empirically: a delegating run's `result.usage.output_tokens` was *fewer* than its sub-agent transcript's output total, and output tokens are never cached, so the result envelope cannot include the sub-agent's. So `tokensIn`/`tokensOut` are a **lower bound** when the agent delegates; `costUsd` is the run's reported `total_cost_usd` (whether it folds in sub-agent billing isn't independently confirmed here). Summing sub-agent tokens too is a possible future enhancement (tied to the next benchmark re-run). The clearest signal stays tool-call reduction (now the true main+sub total); cost/tokens run closer because `cartograph_explore` returns large rich context that offsets the file-read savings. Sub-agent `outBytes` land in the sub-agent's own context (not the main thread's) — that's the point of delegation — so `subOutBytes` is tracked separately from `cgOutBytes`/`readOutBytes`.

> The published benchmark table in the repo's top-level `README.md` predates sub-agent-count recovery (its tool-call numbers are main-only); it refreshes to full main+sub counts on the next `--publish` sweep (see the B5 re-run in `BACKLOG.md`), at which point `render-table.mjs`'s methodology note should be updated from "conservative lower bound" to the true-total wording.

## Reading the output

`aggregate.mjs` prints one row per corpus as `WITH→WITHOUT (savings%)` for cost,
tokens, time, and tool-calls, then an `AVERAGE SAVINGS` line. Positive % = the
`with` arm was cheaper / fewer / faster.

```
corpus            lang     | cost  WITH→WITHOUT        | tokens WITH→WITHOUT   | ...
gin               Go       | $0.41→$0.83 (  51%) | 410k→1.9M (  78%) | 48s→2m14s (  64%) | 9→44 (  80%) | 0
...
AVERAGE SAVINGS: cost 38% · tokens 57% · time 46% · tool-calls 71%
```

- **dropped** counts runs excluded as rate-limited/errored — medians are taken
  on the survivors and the exclusion is always reported, never silent.
- The per-run `*.json` sidecars (one per arm per run) carry the full breakdown
  (`cgOutBytes` / `readOutBytes`, `taskSpawns`/`exploreSpawns`, `subCalls` /
  `subCgCalls` / `subOutBytes` / `fullCalls`, per-call list) for drilling into
  _why_ an arm won.

## Files

| File | Role |
|---|---|
| `run-sweep.mjs` | Top-level: select corpora, run each A/B serially (with backoff), aggregate. |
| `run-ab.sh` | One corpus: N runs × {with,without}, emits raw `.jsonl` + parsed `.json`. |
| `parse-run.mjs` | stream-json → metrics object (tokens/cost/turns/tool-mix/output-sizes); also recovers sub-agent tool calls from the on-disk session transcript (`fullCalls` = main + sub). |
| `aggregate.mjs` | per-run `.json` → median-per-arm rows + WITH→WITHOUT deltas → `results.json`. |
| `corpus.json` | the 15 corpora, languages, tiers, flow-questions, publish-set flag. |
