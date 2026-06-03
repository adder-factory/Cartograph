#!/usr/bin/env bash
# Parallel test runner — splits the suite into N shards (default 8)
# and runs them concurrently via bun:test's --shard=K/N flag.
# Each shard also runs with --isolate so file-level module mocks do
# not leak between unrelated test files inside the same shard process.
#
# Requires bash 4+ (uses `mapfile` for the retry-failed-files step).
# macOS ships bash 3.2; install GNU bash via `brew install bash`.
# The block below re-execs into bash 4+ if invoked from the system
# bash, so callers (npm scripts / direct invocation) don't need to
# remember the absolute path.
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  for cand in /opt/homebrew/bin/bash /usr/local/bin/bash /opt/local/bin/bash; do
    if [ -x "$cand" ]; then
      exec "$cand" "$0" "$@"
    fi
  done
  echo "test-parallel.sh requires bash 4+. macOS system bash is 3.2; install GNU bash via 'brew install bash'." >&2
  exit 1
fi
#
# Why this script exists: bun:test has no native cross-file
# parallelism (each file runs in its own subprocess, sequentially).
# Without sharding, the full suite is ~4-5 min wall clock; with
# 8-way sharding on an M-series box it drops to ~1 min when no
# single file dominates. See CLAUDE.md "Test runner" + the
# bun-1.3.14 docs (cross-file parallelism is not on the runner
# roadmap; --shard is the supported pattern).
#
# Usage:
#   npm run test:fast                  # 8 shards
#   N=4 npm run test:fast              # 4 shards (e.g. on a smaller box)
#   N=16 npm run test:fast             # 16 shards (Threadripper / heavy SMP)
#   SHARD_PATTERN='__tests__/sync*.test.ts' npm run test:fast
#                                      # narrow the file glob each shard considers
#
# Exits non-zero if any shard reported a failure.
set -uo pipefail

N="${N:-8}"
PATTERN="${SHARD_PATTERN:-__tests__/*.test.ts}"
RETRY="${RETRY:-3}"   # max retries per failed file in the file-grain pass
TMP_DIR="${TMPDIR:-/tmp}/bun-test-shards-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

run_shard() {
  # $1 = shard index, $2 = log path
  bun test --isolate --shard="$1/$N" --timeout 30000 $PATTERN > "$2" 2>&1
}

shard_fails() {
  # Echo the fail count from a shard log (0 if absent).
  grep -oE "^ +[0-9]+ fail" "$1" | grep -oE "[0-9]+" | tail -1 || echo 0
}

echo "=== running $N shards in parallel (pattern: $PATTERN) ==="
START=$(date +%s)

for i in $(seq 1 "$N"); do
  run_shard "$i" "$TMP_DIR/shard-$i.log" &
done
wait

# Retry pass — F#68 (2026-05-28). On macOS the bun:test process can
# stall under load (the 8 parallel shards self-stress the box; under
# this, JS timers can stall 5-30s and miss their waitFor budgets).
# A whole-shard retry doesn't help because the cumulative state from
# 36 sibling files reliably re-creates the same flake. Instead, when
# a shard fails, re-run JUST THE FAILED FILE(S) in a fresh bun
# process — that breaks the accumulation and the flake usually
# clears. A real bug fails both runs. Set RETRY=0 to disable.
retried=()
# Default empty arrays trip set -u when expanded; arm them in advance.
if [ "$RETRY" -gt 0 ]; then
  for i in $(seq 1 "$N"); do
    log="$TMP_DIR/shard-$i.log"
    f=$(shard_fails "$log")
    if [ "${f:-0}" -gt 0 ]; then
      # Extract failed file paths. bun:test prints `<path>:` headers
      # only for files with output (typically failed). Heuristic:
      # every `__tests__/X.test.ts:` header in the log is a file
      # with output — retry all of them.
      failed_files=()
      mapfile -t failed_files < <(grep -oE "^__tests__/[^:]+\.test\.ts:" "$log" | tr -d ':' | sort -u)
      if [ "${#failed_files[@]}" -eq 0 ]; then
        echo "=== shard $i had $f fails but no file headers to retry; skipping ==="
        continue
      fi
      echo "=== retrying shard $i failed files in fresh processes (up to $RETRY attempts each): ${failed_files[*]} ==="
      mv "$log" "$log.first"
      retry_total_fail=0
      : > "$log"
      for ff in "${failed_files[@]}"; do
        attempt=0
        passed=false
        while [ "$attempt" -lt "$RETRY" ]; do
          attempt=$((attempt+1))
          bun test --isolate --timeout 30000 "$ff" >> "$log" 2>&1
          if [ "$?" -eq 0 ]; then
            passed=true
            echo "  -> $ff passed on attempt $attempt"
            break
          fi
        done
        if ! $passed; then retry_total_fail=$((retry_total_fail+1)); fi
      done
      if [ "$retry_total_fail" -eq 0 ]; then
        retried+=("$i")
        echo "  -> shard $i's failed file(s) all passed (flake survived)"
      else
        echo "  -> shard $i's failed file(s) still failed after retries (real failure)"
      fi
    fi
  done
fi
END=$(date +%s)

# Aggregate.
total_pass=0
total_fail=0
total_skip=0
exit_code=0
echo "=== per-shard ==="
for i in $(seq 1 "$N"); do
  log="$TMP_DIR/shard-$i.log"
  first_log="$TMP_DIR/shard-$i.log.first"
  retry_won=false
  if [[ " ${retried[*]:-} " == *" $i "* ]]; then
    retry_won=true
  fi
  # Whenever a retry was attempted (won or not), the ORIGINAL shard
  # log (`$first_log`) is the source of truth for pass/fail/skip
  # totals — the retry log concatenates multiple per-file runs and
  # `tail -1` of that picks only the last file's summary, silently
  # undercounting `total_fail` when multiple files fail retries.
  # When the retry won, reclassify the originally-failed tests as
  # passes; when the retry didn't fully clear, keep the original
  # fail count visible.
  if [ -f "$first_log" ]; then
    p=$(grep -oE "^ +[0-9]+ pass" "$first_log" | grep -oE "[0-9]+" | tail -1)
    f=$(grep -oE "^ +[0-9]+ fail" "$first_log" | grep -oE "[0-9]+" | tail -1)
    s=$(grep -oE "^ +[0-9]+ skip" "$first_log" | grep -oE "[0-9]+" | tail -1)
    summary=$(grep -E "^Ran " "$first_log" | tail -1)
    if $retry_won; then
      p=$((${p:-0} + ${f:-0}))
      f=0
    fi
  else
    p=$(grep -oE "^ +[0-9]+ pass" "$log" | grep -oE "[0-9]+" | tail -1)
    f=$(grep -oE "^ +[0-9]+ fail" "$log" | grep -oE "[0-9]+" | tail -1)
    s=$(grep -oE "^ +[0-9]+ skip" "$log" | grep -oE "[0-9]+" | tail -1)
    summary=$(grep -E "^Ran " "$log" | tail -1)
  fi
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${f:-0}))
  total_skip=$((total_skip + ${s:-0}))
  marker="  ok "
  if [ "${f:-0}" -gt 0 ]; then
    marker="  ✗  "
    exit_code=1
  elif $retry_won; then
    marker="  ↻  "  # flake survived via retry
  fi
  printf "%s shard %d: pass=%-4s fail=%-3s skip=%-3s | %s\n" "$marker" "$i" "${p:-0}" "${f:-0}" "${s:-0}" "$summary"
done

echo "=== aggregate ==="
echo "  wall clock: $((END - START))s ($N shards in parallel)"
echo "  pass: $total_pass   fail: $total_fail   skip: $total_skip"
if [ "${#retried[@]}" -gt 0 ]; then
  echo "  flake-survived shards: ${retried[*]:-}"
fi

if [ "$exit_code" -ne 0 ]; then
  echo "=== failed shards (first 50 lines of each) ==="
  for i in $(seq 1 "$N"); do
    log="$TMP_DIR/shard-$i.log"
    f=$(grep -oE "^ +[0-9]+ fail" "$log" | grep -oE "[0-9]+" | tail -1)
    if [ "${f:-0}" -gt 0 ]; then
      echo "--- shard $i ---"
      grep -E "^\(fail\)|^error: |TypeError" "$log" | head -10
    fi
  done
fi

exit "$exit_code"
