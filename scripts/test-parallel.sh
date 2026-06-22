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
# Append-only record of files that FAILED in a parallel shard but PASSED in
# isolation on retry (i.e. flaked). Without this, the EXIT trap wipes the
# shard logs and a chronically order-dependent test is reclassified as a
# harmless flake every run with no trail. Repeat offenders show up here.
FLAKE_LOG="${FLAKE_LOG:-.flake-log}"
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

sum_count() {
  # $1 = log path, $2 = pass|fail|skip. Used for retry logs, which
  # concatenate many one-file runs and therefore need summing rather
  # than tailing the last summary line.
  grep -oE "^ +[0-9]+ $2" "$1" | grep -oE "[0-9]+" | awk '{ n += $1 } END { print n + 0 }'
}

failed_files_from_log() {
  # Echo only files that contain a bun:test `(fail)` record. Many of
  # our tests print normal diagnostic output, which gives them file
  # headers even when every test in that file passed. Retrying every
  # header hides the real failing file and pollutes .flake-log.
  awk '
    /^[[:space:]]*[0-9]+ test(s)? failed:$/ {
      in_summary = 1
      next
    }
    in_summary == 1 {
      next
    }
    /^__tests__\/[^:]+\.test\.ts:$/ {
      file = substr($0, 1, length($0) - 1)
      next
    }
    /^\(fail\)/ && file != "" {
      seen[file] = 1
    }
    END {
      for (f in seen) print f
    }
  ' "$1" | sort
}

retry_won_shard() {
  # $1 = shard index. `retried` contains shards whose failed files all
  # passed in fresh per-file processes.
  [[ " ${retried[*]:-} " == *" $1 "* ]]
}

if [ "${TEST_PARALLEL_EXTRACT_FAILED_FILES:-0}" = "1" ]; then
  if [ "$#" -ne 1 ]; then
    echo "usage: TEST_PARALLEL_EXTRACT_FAILED_FILES=1 scripts/test-parallel.sh <log>" >&2
    exit 2
  fi
  failed_files_from_log "$1"
  exit 0
fi

echo "=== running $N shards in parallel (pattern: $PATTERN) ==="
START=$(date +%s)

pids=()
shard_status=()
for i in $(seq 1 "$N"); do
  run_shard "$i" "$TMP_DIR/shard-$i.log" &
  pids[$i]=$!
done
for i in $(seq 1 "$N"); do
  if wait "${pids[$i]}"; then
    shard_status[$i]=0
  else
    shard_status[$i]=$?
  fi
done

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
    status="${shard_status[$i]:-0}"
    if [ "${f:-0}" -gt 0 ] || [ "$status" -ne 0 ]; then
      # A non-zero shard exit with zero failed tests is a process-level
      # failure (native crash / signal / post-summary teardown), not a
      # per-file assertion failure. Retry the whole shard so the flake log
      # does not misclassify every file header in the shard as a flaky file.
      if [ "$status" -ne 0 ] && { [ "${f:-0}" -eq 0 ] || ! grep -qE "^Ran " "$log"; }; then
        if grep -qE "^Ran " "$log"; then
          echo "=== shard $i exited $status after printing a summary with no failed tests; retrying the whole shard (up to $RETRY attempts) ==="
        else
          echo "=== shard $i exited $status before printing a summary; retrying the whole shard (up to $RETRY attempts) ==="
        fi
        mv "$log" "$log.first"
        shard_passed=false
        attempt=0
        while [ "$attempt" -lt "$RETRY" ]; do
          attempt=$((attempt+1))
          bun test --isolate --shard="$i/$N" --timeout 30000 $PATTERN > "$log" 2>&1
          if [ "$?" -eq 0 ]; then
            shard_passed=true
            retried+=("$i")
            echo "  -> shard $i passed as a whole on attempt $attempt"
            break
          fi
        done
        if $shard_passed; then
          continue
        fi
        echo "  -> shard $i still failed/crashed after whole-shard retries; treating as failed"
        continue
      fi

      # Extract failed file paths. Fall back to all emitted test-file
      # headers only if bun:test did not print `(fail)` records; that
      # keeps odd formatter failures debuggable without misclassifying
      # every noisy but passing file as flaky.
      failed_files=()
      mapfile -t failed_files < <(failed_files_from_log "$log")
      if [ "${#failed_files[@]}" -eq 0 ]; then
        mapfile -t failed_files < <(grep -oE "^__tests__/[^:]+\.test\.ts:" "$log" | tr -d ':' | sort -u)
      fi
      if [ "${#failed_files[@]}" -eq 0 ]; then
        echo "=== shard $i exited $status with ${f:-0} fails but no file headers to retry; treating as failed ==="
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
            # Persist the flake before the EXIT trap wipes the shard logs,
            # with a first-failure excerpt so a real order-dependent bug
            # hiding behind the retry is traceable across runs.
            {
              echo "[$(date -u +%FT%TZ)] flake-survived: $ff (failed in shard $i, passed in isolation on attempt $attempt)"
              grep -A2 -F "$ff" "$log.first" 2>/dev/null | head -6
            } >> "$FLAKE_LOG" 2>/dev/null || true
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
  if retry_won_shard "$i"; then
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
      if [ -z "${summary:-}" ]; then
        # The shard process can crash before its final summary. When
        # the whole shard then passes in a fresh isolated retry, count
        # the retry summary so the aggregate is not misleadingly shown
        # as pass=0 for the recovered shard.
        p=$(sum_count "$log" pass)
        s=$(sum_count "$log" skip)
        summary=$(grep -E "^Ran " "$log" | tail -1)
        summary="${summary:-retried shard in a fresh process}"
      else
        p=$((${p:-0} + ${f:-0}))
      fi
      f=0
    fi
  else
    p=$(grep -oE "^ +[0-9]+ pass" "$log" | grep -oE "[0-9]+" | tail -1)
    f=$(grep -oE "^ +[0-9]+ fail" "$log" | grep -oE "[0-9]+" | tail -1)
    s=$(grep -oE "^ +[0-9]+ skip" "$log" | grep -oE "[0-9]+" | tail -1)
    summary=$(grep -E "^Ran " "$log" | tail -1)
  fi
  status="${shard_status[$i]:-0}"
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${f:-0}))
  total_skip=$((total_skip + ${s:-0}))
  marker="  ok "
  if [ "${f:-0}" -gt 0 ] || { [ "$status" -ne 0 ] && ! $retry_won; }; then
    marker="  ✗  "
    exit_code=1
  elif $retry_won; then
    marker="  ↻  "  # flake survived via retry
  fi
  if [ "$status" -ne 0 ] && ! $retry_won; then
    summary="${summary:-shard process exited $status before printing a summary}"
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
    first_log="$TMP_DIR/shard-$i.log.first"
    status="${shard_status[$i]:-0}"
    failed=false
    if [ -f "$first_log" ]; then
      if ! retry_won_shard "$i"; then
        failed=true
      fi
    else
      f=$(grep -oE "^ +[0-9]+ fail" "$log" | grep -oE "[0-9]+" | tail -1)
      if [ "${f:-0}" -gt 0 ] || [ "$status" -ne 0 ]; then
        failed=true
      fi
    fi

    if $failed; then
      echo "--- shard $i ---"
      if [ -f "$first_log" ]; then
        echo "(original shard summary)"
        grep -E "^ +[0-9]+ (pass|fail|skip)|^Ran " "$first_log" | tail -4
        echo "(retry failures)"
      fi
      grep -B1 -E "^\(fail\)|^error: |TypeError|Expected|Received" "$log" | head -50
    fi
  done
fi

exit "$exit_code"
