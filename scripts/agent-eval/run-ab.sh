#!/usr/bin/env bash
# Headless with/without A/B eval for THIS fork's cartograph MCP on one corpus.
# Cartograph is the ONLY variable: both arms launch `claude -p` with
# --strict-mcp-config — `with` = cartograph-only MCP, `without` = empty MCP.
# Built-in Read/Grep/Bash stay available in both arms, so the delta isolates
# cartograph's contribution.
#
# Ported from upstream colbymchenry/codegraph scripts/agent-eval/run-all.sh
# (commit a6183d7c). Fork adaptations:
#   - no global `cartograph` binary: the MCP server is `bun src/bin/cartograph.ts`
#   - the serve flag is `--project-path` (not upstream's `--path`)
#   - N runs per arm (median is taken downstream by aggregate.mjs)
#   - a small inter-run sleep + a soft rate-limit notice (eval shares the
#     user's Max account with the live session — keep it serial)
#
# Usage: run-ab.sh <corpus-path> "<question>" <out-subdir> [runs] [model]
# Env:   BUN_BIN        bun binary (default: command -v bun)
#        CG_ENTRY       cartograph entrypoint (default: <repo>/src/bin/cartograph.ts)
#        AGENT_EVAL_OUT output root (default: /tmp/agent-eval)
#        MAX_BUDGET_USD per-run hard cap passed to claude (default: 4)
#        RUN_SLEEP_S    seconds to sleep between runs (default: 3)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORPUS="${1:?usage: run-ab.sh <corpus-path> \"<question>\" <out-subdir> [runs] [model]}"
Q="${2:?question required}"
SUB="${3:?out-subdir required}"
RUNS="${4:-1}"
MODEL="${5:-opus}"

BUN_BIN="${BUN_BIN:-$(command -v bun)}"
CG_ENTRY="${CG_ENTRY:-$REPO_ROOT/src/bin/cartograph.ts}"
OUT="${AGENT_EVAL_OUT:-/tmp/agent-eval}/$SUB"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-4}"
RUN_SLEEP_S="${RUN_SLEEP_S:-3}"
EVAL_NO_DELEGATE="${EVAL_NO_DELEGATE:-0}"
HARNESS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

# Default 0 (natural) is the REPRESENTATIVE measurement used for the published
# benchmark: the agent behaves as it normally would (delegating to an Explore
# sub-agent per the host's CLAUDE.md), which is precisely how Cartograph gets
# used — and where its value shows. Setting EVAL_NO_DELEGATE=1 appends the
# single-agent STEER below to BOTH arms: it forces a no-delegation run so every
# tool call lands in the main stream (fully observable, handy for debugging or
# A/B-ing the steering itself), BUT it suppresses the delegation pattern
# Cartograph is designed around, so it UNDERSELLS Cartograph — not for publishing.
STEER='You are running a one-shot code-exploration evaluation. Answer the question directly using the tools available in THIS session. Do NOT spawn sub-agents or delegate to an Explore/Task/Agent sub-agent — perform all retrieval and reasoning yourself, so the run is fully observable and reproducible.'

[ -n "$BUN_BIN" ] || { echo "no bun on PATH (set BUN_BIN)"; exit 1; }
[ -f "$CG_ENTRY" ] || { echo "cartograph entry not found: $CG_ENTRY"; exit 1; }
[ -d "$CORPUS/.cartograph" ] || { echo "no .cartograph index at $CORPUS — index it first"; exit 1; }

# MCP config files. `with` points the cartograph server at the corpus; `without`
# is an empty server set so only built-in tools are available.
cat > "$OUT/mcp-cartograph.json" <<JSON
{"mcpServers":{"cartograph":{"command":"$BUN_BIN","args":["$CG_ENTRY","serve","--mcp","--project-path","$CORPUS"]}}}
JSON
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"

echo "###### corpus:   $CORPUS"
echo "###### question: $Q"
echo "###### runs:     $RUNS x {with,without}   model: $MODEL   out: $OUT"
echo

# One headless run. $1=arm label, $2=mcp config, $3=run index, $4=corpus name, $5=language
run_one() {
  local arm="$1" cfg="$2" r="$3" name="$4" lang="$5"
  local base="$OUT/${arm}-run${r}"
  echo "---- [$name] $arm run $r/$RUNS ----"
  local cargs=( -p "$Q"
    --output-format stream-json --verbose
    --permission-mode bypassPermissions
    --model "$MODEL"
    --max-budget-usd "$MAX_BUDGET_USD"
    --strict-mcp-config --mcp-config "$cfg" )
  [ "$EVAL_NO_DELEGATE" = "1" ] && cargs+=( --append-system-prompt "$STEER" )
  ( cd "$CORPUS" && claude "${cargs[@]}" > "$base.jsonl" 2>"$base.err" )
  local ec=$?
  echo "exit $ec -> $base.jsonl ($(wc -l < "$base.jsonl" 2>/dev/null | tr -d ' ') lines)"
  [ "$ec" -ne 0 ] && tail -2 "$base.err" 2>/dev/null
  node "$HARNESS/parse-run.mjs" "$base.jsonl" \
    --json "$base.json" \
    --meta "corpus=$name,language=$lang,arm=$arm,run=$r" 2>&1 || true
  echo
}

NAME="$(basename "$CORPUS")"
LANG="${CORPUS_LANG:-?}"
for r in $(seq 1 "$RUNS"); do
  run_one "with"    "$OUT/mcp-cartograph.json" "$r" "$NAME" "$LANG"
  sleep "$RUN_SLEEP_S"
  run_one "without" "$OUT/mcp-empty.json"     "$r" "$NAME" "$LANG"
  [ "$r" -lt "$RUNS" ] && sleep "$RUN_SLEEP_S"
done

echo "############################## A/B COMPLETE ($NAME) ##############################"
