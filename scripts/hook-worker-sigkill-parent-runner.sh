#!/usr/bin/env bash
# G10.8 — SIGKILL the parent mid-flight, see if the hook-worker child
# notices and exits via disconnect, or sits as an orphan.
#
# Theory: when the parent dies abruptly (no graceful shutdown, no
# explicit kill() on the child), the OS closes the IPC channel. The
# child's `process.on('disconnect')` SHOULD fire and exit. If it
# doesn't fire under Bun's IPC adapter for SIGKILL-induced channel
# closure, we have the G10.8 reproducer.

set -uo pipefail
cd "$(dirname "$0")/.."

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# Run the bench in the background, capture PIDs once it prints, SIGKILL
# the parent, then check the child.
bun bench/hook-worker-parent-exit.mts > "$OUT" 2>&1 &
PARENT_PID=$!

# Poll the output for the PARENT/CHILDREN line.
for _ in {1..50}; do
  if grep -q '^PARENT=' "$OUT"; then break; fi
  sleep 0.1
done

LINE=$(grep '^PARENT=' "$OUT" || true)
if [[ -z "$LINE" ]]; then
  echo "FATAL: bench did not emit PARENT/CHILDREN line within 5s"
  kill -9 "$PARENT_PID" 2>/dev/null || true
  exit 2
fi

CHILDREN=$(echo "$LINE" | sed -E 's/.*CHILDREN=([0-9,]*).*/\1/')
TEMPDIR=$(echo "$LINE" | sed -E 's/.*TEMPDIR=(.*)$/\1/')
echo "parent pid: $PARENT_PID  children: ${CHILDREN:-<none>}"

if [[ -z "$CHILDREN" ]]; then
  echo "no children spawned — skipping kill test"
  kill -9 "$PARENT_PID" 2>/dev/null || true
  wait "$PARENT_PID" 2>/dev/null || true
  exit 0
fi

# SIGKILL the parent BEFORE it reaches its normal exit point (the
# bench script will still print its PARENT/CHILDREN line and then loop
# at process.exit — by SIGKILLing here we skip the clean shutdown).
echo "SIGKILL parent pid $PARENT_PID"
kill -9 "$PARENT_PID" 2>/dev/null || true
wait "$PARENT_PID" 2>/dev/null || true

# Wait for the OS / IPC channel close to propagate.
SETTLE_MS=${G10_8_SETTLE_MS:-2000}
sleep $(awk "BEGIN { print $SETTLE_MS / 1000 }")

ORPHANS=()
IFS=',' read -ra ARR <<< "$CHILDREN"
for pid in "${ARR[@]}"; do
  if ps -p "$pid" >/dev/null 2>&1; then
    ORPHANS+=("$pid")
  fi
done

if [[ ${#ORPHANS[@]} -eq 0 ]]; then
  echo "✓ children exited cleanly after parent SIGKILL"
  [[ -n "$TEMPDIR" && -d "$TEMPDIR" ]] && rm -rf "$TEMPDIR"
  exit 0
fi

echo "❌ orphan hook-worker children survived SIGKILL of parent: ${ORPHANS[*]}"
ps -o pid,ppid,etime,%cpu,rss,command -p "${ORPHANS[@]}"
for pid in "${ORPHANS[@]}"; do
  kill "$pid" 2>/dev/null || true
done
[[ -n "$TEMPDIR" && -d "$TEMPDIR" ]] && rm -rf "$TEMPDIR"
exit 1
