#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATION="$ROOT/.github/workflows/v2-rust.yml"
RELEASE="$ROOT/.github/workflows/release.yml"
PULL_HELPER="$ROOT/scripts/pull-pinned-image.sh"

fail() {
  echo "release workflow contract failed: $1" >&2
  exit 1
}

grep -Fq 'attest-main-gate:' "$VALIDATION" || fail 'main-gate attestation job is missing'
grep -Fq 'actions/attest-build-provenance@' "$VALIDATION" || fail 'main-gate provenance is missing'
# GitHub evaluates this expression; the local contract test needs the literal bytes.
# shellcheck disable=SC2016
grep -Fq 'v2-main-gate-${{ github.sha }}' "$VALIDATION" || fail 'main-gate artifact is not SHA-bound'
grep -Eq '^  pull_request:$' "$VALIDATION" || fail 'pull-request validation trigger is missing'
push_branches="$(awk '
  /^  push:$/ { in_push = 1; next }
  in_push && /^    branches:$/ { in_branches = 1; next }
  in_push && in_branches && /^    [[:alnum:]_-]+:$/ { exit }
  in_push && /^  [[:alnum:]_-]+:$/ { exit }
  in_push && in_branches { print }
' "$VALIDATION" | sed '/^[[:space:]]*$/d')"
[[ "$push_branches" == '      - main' ]] || fail 'push validation must be scoped only to main'
grep -Fq 'strategy:' "$VALIDATION" || fail 'live PostgreSQL shards are missing'
for shard in database runtime operations; do
  grep -Fq -- "- $shard" "$VALIDATION" || fail "live shard $shard is missing"
done

if grep -Fq 'uses: ./.github/workflows/v2-rust.yml' "$RELEASE"; then
  fail 'tag workflow still reruns the full validation workflow'
fi
grep -Fq "tags: ['v*']" "$RELEASE" || fail 'release workflow tag trigger is missing'
if grep -Eq '^[[:space:]]{2}workflow_dispatch:' "$RELEASE"; then
  fail 'release workflow manual dispatch duplicates the tag-specific native builds'
fi
grep -Fq 'verify-main-gate:' "$RELEASE" || fail 'release main-gate verification job is missing'
grep -Fq 'gh attestation verify' "$RELEASE" || fail 'release does not verify main-gate provenance'
grep -Fq -- '--source-ref refs/heads/main' "$RELEASE" || fail 'release does not bind evidence to main'
grep -Fq 'needs: verify-main-gate' "$RELEASE" || fail 'release builds do not depend on exact main evidence'
grep -Fq 'scripts/pull-pinned-image.sh' "$VALIDATION" || fail 'ParadeDB pulls do not use bounded retries'
grep -Fq "cache-workspace-crates: 'true'" "$VALIDATION" || fail 'live shards do not reuse the compiled workspace'

unpinned_actions="$({
  grep -hE '^[[:space:]]*(- )?uses:' "$VALIDATION" "$RELEASE"
} | grep -Ev 'uses: (\./|[^[:space:]]+@[0-9a-f]{40}([[:space:]]|$))' || true)"
if [[ -n "$unpinned_actions" ]]; then
  printf 'Unpinned release action references:\n%s\n' "$unpinned_actions" >&2
  fail 'every external action must use a full commit digest'
fi

unpinned_status=0
CARTOGRAPH_DOCKER_BIN=/usr/bin/false "$PULL_HELPER" example.invalid/cartograph:latest 1 \
  >/dev/null 2>&1 || unpinned_status=$?
[[ "$unpinned_status" -eq 2 ]] || fail 'unpinned image input was not rejected'

fixture="$(mktemp -d "${TMPDIR:-/tmp}/cartograph-pull-test.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
fake_docker="$fixture/docker"
cat >"$fake_docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${CARTOGRAPH_FAKE_DOCKER_STATE:?}"
case "${1:-}:${2:-}" in
  image:inspect)
    [[ -f "$state/available" ]]
    ;;
  pull:*)
    count=0
    [[ ! -f "$state/count" ]] || count="$(<"$state/count")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$state/count"
    if (( count >= 3 )); then
      : >"$state/available"
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod 0755 "$fake_docker"
mkdir -p "$fixture/state"

IMAGE="example.invalid/cartograph@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CARTOGRAPH_DOCKER_BIN="$fake_docker" \
  CARTOGRAPH_FAKE_DOCKER_STATE="$fixture/state" \
  CARTOGRAPH_IMAGE_PULL_RETRY_DELAY_SECONDS=0 \
  "$PULL_HELPER" "$IMAGE" 4 >/dev/null
[[ "$(<"$fixture/state/count")" == 3 ]] || fail 'bounded pull retry count changed'

echo 'Release workflow attestation, sharding, and pinned-image retry contracts passed.'
