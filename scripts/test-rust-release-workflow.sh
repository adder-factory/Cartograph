#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATION="$ROOT/.github/workflows/v2-rust.yml"
RELEASE="$ROOT/.github/workflows/release.yml"
STABLE_CANARY="$ROOT/.github/workflows/stable-canary.yml"
PULL_HELPER="$ROOT/scripts/pull-pinned-image.sh"
SMOKE_HELPER="$ROOT/scripts/smoke-rust-release.sh"
UNIX_BUILD_HELPER="$ROOT/scripts/build-rust-release.sh"
LINUX_BUILD_HELPER="$ROOT/scripts/build-linux-rust-release.sh"
UNIX_INSTALLER="$ROOT/install.sh"
WINDOWS_INSTALLER="$ROOT/install.ps1"
UPGRADE_SOURCE="$ROOT/crates/cartograph-cli/src/upgrade.rs"
CLI_SOURCE="$ROOT/crates/cartograph-cli/src/main.rs"
DENY_CONFIG="$ROOT/deny.toml"

fail() {
  echo "release workflow contract failed: $1" >&2
  exit 1
}

job_block() {
  local workflow="$1"
  local job="$2"
  awk -v header="  $job:" '
    $0 == header { capture = 1; next }
    capture && /^  [[:alnum:]_-]+:$/ { exit }
    capture { print }
  ' "$workflow"
}

literal_count() {
  local needle="$1"
  awk -v needle="$needle" 'index($0, needle) { count += 1 } END { print count + 0 }' \
    "$VALIDATION" "$RELEASE"
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
for parallel_job in windows-portability macos-portability linux-release-portability paradedb; do
  if job_block "$VALIDATION" "$parallel_job" | grep -Fq 'needs: quality'; then
    fail "independent gate $parallel_job is serialized behind quality"
  fi
done
grep -Fq 'cargo doc --locked --workspace --all-features --no-deps' "$VALIDATION" || \
  fail 'strict all-feature rustdoc validation is missing'
grep -Fq 'cargo test --locked --workspace --all-features' "$VALIDATION" || \
  fail 'unit tests do not exercise all features'
grep -Fq '.evidence.packet.abstention == null' "$VALIDATION" || \
  fail 'candidate self-index context does not reject an abstaining packet'
grep -Fq '(.evidence.packet.evidence | type == "array")' "$VALIDATION" || \
  fail 'candidate self-index context does not require the packet evidence array'
grep -Fq '(.evidence.packet.evidence | length) > 0' "$VALIDATION" || \
  fail 'candidate self-index context does not require real retrieval evidence'
if grep -Fq '(.evidence | length) > 0' "$VALIDATION"; then
  fail 'candidate self-index context still accepts a merely nonempty response envelope'
fi
self_context_filter='.
  | .freshness == "current"
  and .evidence.packet.abstention == null
  and (.evidence.packet.evidence | type == "array")
  and (.evidence.packet.evidence | length) > 0'
if jq -e "$self_context_filter" <<<'{"freshness":"current","evidence":{"packet":{"abstention":null,"evidence":[]}}}' \
  >/dev/null; then
  fail 'candidate self-index context accepts an empty evidence packet'
fi
if jq -e "$self_context_filter" <<<'{"freshness":"current","evidence":{"packet":{"abstention":"no-match","evidence":[{}]}}}' \
  >/dev/null; then
  fail 'candidate self-index context accepts an abstaining packet'
fi
jq -e "$self_context_filter" \
  <<<'{"freshness":"current","evidence":{"packet":{"abstention":null,"evidence":[{}]}}}' \
  >/dev/null || fail 'candidate self-index context rejects real current evidence'
grep -Fq 'macos-portability:' "$VALIDATION" || fail 'macOS strict portability gate is missing'
grep -Fq 'cargo +stable clippy --locked --workspace --all-targets --all-features -- -D warnings' \
  "$STABLE_CANARY" || fail 'latest-stable strict compatibility canary is missing'
grep -Fq 'Verify the reviewed production pin tracks latest stable' "$STABLE_CANARY" || \
  fail 'latest-stable canary does not detect a stale production toolchain pin'
canary_clippy_line="$(grep -nF 'name: All-target, all-feature Clippy on latest stable' \
  "$STABLE_CANARY" | cut -d: -f1)"
canary_tests_line="$(grep -nF 'name: All-feature tests on latest stable' \
  "$STABLE_CANARY" | cut -d: -f1)"
canary_rustdoc_line="$(grep -nF 'name: Strict all-feature rustdoc on latest stable' \
  "$STABLE_CANARY" | cut -d: -f1)"
canary_pin_line="$(grep -nF 'name: Verify the reviewed production pin tracks latest stable' \
  "$STABLE_CANARY" | cut -d: -f1)"
[[ "$canary_pin_line" -gt "$canary_clippy_line" && \
  "$canary_pin_line" -gt "$canary_tests_line" && \
  "$canary_pin_line" -gt "$canary_rustdoc_line" ]] || \
  fail 'stale-pin reporting can skip latest-stable compatibility evidence'
if grep -Fq 'continue-on-error:' "$STABLE_CANARY"; then
  fail 'latest-stable compatibility or stale-pin reporting was made non-blocking'
fi
if grep -Eiq 'nightly|miri|sanitizer|cargo[- ]fuzz' "$STABLE_CANARY"; then
  fail 'production compatibility canary must use stable Rust only'
fi
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
grep -Fq 'NOTES="docs/releases/$TAG.md"' "$RELEASE" || \
  fail 'release notes are not loaded from the tracked versioned file'
grep -Fq -- '--notes-file "$NOTES"' "$RELEASE" || \
  fail 'tracked release notes are not supplied to GitHub'
if grep -Fq -- '--generate-notes' "$RELEASE"; then
  fail 'release publication can still replace detailed notes with generated changelog text'
fi
grep -Fq 'needs: verify-main-gate' "$RELEASE" || fail 'release builds do not depend on exact main evidence'
grep -Fq 'cache_key: release-windows-x64' "$RELEASE" || \
  fail 'Windows release artifacts do not use a release-profile cache'
if grep -Fq 'cache_key: v2-windows' "$RELEASE"; then
  fail 'Windows release build still shares the dev and Clippy cache'
fi
grep -Fq 'os: macos-26' "$RELEASE" || fail 'Apple Silicon release does not target macOS 26'
grep -Fq 'rust_target: aarch64-apple-darwin' "$RELEASE" || \
  fail 'Apple Silicon release target is missing'
if grep -Fq 'darwin-x64' "$RELEASE" "$UNIX_BUILD_HELPER" "$UPGRADE_SOURCE"; then
  fail 'Intel macOS remains in the native release contract'
fi
if grep -Fq 'x86_64-apple-darwin' "$RELEASE" "$UNIX_BUILD_HELPER" "$UPGRADE_SOURCE" "$DENY_CONFIG"; then
  fail 'Intel macOS remains in a compiled or audited target set'
fi
if grep -Eq '(i[3-6]86|armv7|thumbv7|windows-x86|linux-x86)' \
  "$RELEASE" "$UNIX_BUILD_HELPER" "$LINUX_BUILD_HELPER" "$DENY_CONFIG"; then
  fail 'a 32-bit native release target is configured'
fi
grep -Fq '#[cfg(not(target_pointer_width = "64"))]' "$CLI_SOURCE" || \
  fail 'the native CLI does not fail closed on 32-bit targets'
grep -Fq 'Cartograph v2 supports only 64-bit operating systems.' "$CLI_SOURCE" || \
  fail 'the 32-bit compile failure is not actionable'
grep -Fq 'rust:1.97.1-trixie@sha256:' "$VALIDATION" || \
  fail 'Linux validation does not build on current stable Debian'
grep -Fq 'debian:13-slim@sha256:' "$VALIDATION" || \
  fail 'Linux validation does not smoke on current stable Debian'
grep -Fq 'rust:1.97.1-trixie@sha256:' "$RELEASE" || \
  fail 'Linux releases do not build on current stable Debian'
grep -Fq 'debian:13-slim@sha256:' "$RELEASE" || \
  fail 'Linux releases do not smoke on current stable Debian'
if grep -Eq '(bookworm|debian:12|Debian 12|glibc 2\.36)' \
  "$VALIDATION" "$RELEASE" "$LINUX_BUILD_HELPER"; then
  fail 'the old Debian 12 compatibility floor remains configured'
fi
grep -Fq 'MACOSX_DEPLOYMENT_TARGET=26.0' "$UNIX_BUILD_HELPER" || \
  fail 'macOS release binaries do not require the current major version'
grep -Fq 'minos 26.0' "$UNIX_BUILD_HELPER" || \
  fail 'macOS release binaries do not verify their minimum OS contract'
grep -Fq "TARGET_ROOT=\"\${CARGO_TARGET_DIR:-target}\"" "$UNIX_BUILD_HELPER" || \
  fail 'release builds do not honor an isolated Cargo target directory'
grep -Fq -- '--env CARGO_TARGET_DIR=/tmp/cartograph-target' "$LINUX_BUILD_HELPER" || \
  fail 'Linux container builds can follow a host target symlink'
grep -Fq 'requires glibc 2.41 or newer' "$UNIX_INSTALLER" || \
  fail 'the Unix installer does not reject old Linux before download'
grep -Fq 'requires macOS 26 or newer' "$UNIX_INSTALLER" || \
  fail 'the Unix installer does not reject old macOS before download'
grep -Fq "{ 26100 } else { 26200 }" "$WINDOWS_INSTALLER" || \
  fail 'the Windows installer does not reject old Windows before download'
if grep -Fq 'Swatinem/rust-cache@' "$VALIDATION" "$RELEASE"; then
  fail 'Rust cache still bundles the deprecated core-punycode dependency path'
fi
CACHE_ACTION_SHA='55cc8345863c7cc4c66a329aec7e433d2d1c52a9'
restore_count="$(literal_count "actions/cache/restore@$CACHE_ACTION_SHA")"
[[ "$restore_count" == 5 ]] || fail 'every Rust cache restore must use pinned actions/cache v6.1.0'
save_count="$(literal_count "actions/cache/save@$CACHE_ACTION_SHA")"
[[ "$save_count" == 4 ]] || fail 'bounded main, Windows, macOS, and release cache saves are missing'
for cache_path in \
  '.cargo/registry/index/' \
  '.cargo/registry/cache/' \
  '.cargo/git/db/' \
  'target/'; do
  path_count="$(literal_count "$cache_path")"
  [[ "$path_count" == 9 ]] || fail "Rust cache path coverage changed for $cache_path"
done
grep -Fq 'steps.rust-cache.outputs.cache-primary-key' "$VALIDATION" || \
  fail 'main cache saves are not bound to their exact restored primary key'
grep -Fq 'steps.rust-cache.outputs.cache-primary-key' "$RELEASE" || \
  fail 'release cache saves are not bound to their exact restored primary key'
grep -Fq 'scripts/pull-pinned-image.sh' "$VALIDATION" || fail 'ParadeDB pulls do not use bounded retries'
grep -Fq 'PostgreSQL init process complete; ready for start up.' "$VALIDATION" || \
  fail 'ParadeDB readiness can accept the temporary bootstrap server'
grep -Fq -- "--command 'SELECT 1;'" "$VALIDATION" || \
  fail 'ParadeDB readiness does not prove a live SQL connection'
grep -Fq -- '-v2-ubuntu-' "$VALIDATION" || \
  fail 'live shards do not reuse the compiled Ubuntu workspace cache'

unpinned_actions="$({
  grep -hE '^[[:space:]]*(- )?uses:' "$VALIDATION" "$RELEASE" "$STABLE_CANARY"
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

unsupported_release_status=0
"$UNIX_BUILD_HELPER" x86_64-apple-darwin darwin-x64 \
  >"$fixture/unsupported-release.out" 2>"$fixture/unsupported-release.err" || \
  unsupported_release_status=$?
[[ "$unsupported_release_status" -eq 2 ]] || fail 'Intel macOS release pairing was not rejected'

fake_uname_dir="$fixture/fake-uname"
mkdir -p "$fake_uname_dir"
cat >"$fake_uname_dir/uname" <<'EOF'
#!/usr/bin/env sh
case "${1:-}" in
  -s) printf '%s\n' "${CARTOGRAPH_FAKE_UNAME_S:?}" ;;
  -m) printf '%s\n' "${CARTOGRAPH_FAKE_UNAME_M:?}" ;;
  *) exit 2 ;;
esac
EOF
chmod 0755 "$fake_uname_dir/uname"
intel_install_status=0
PATH="$fake_uname_dir:$PATH" HOME="$fixture/home" \
  CARTOGRAPH_FAKE_UNAME_S=Darwin CARTOGRAPH_FAKE_UNAME_M=x86_64 "$UNIX_INSTALLER" \
  >"$fixture/intel-install.out" 2>"$fixture/intel-install.err" || intel_install_status=$?
[[ "$intel_install_status" -eq 1 ]] || fail 'Intel macOS installer request was not rejected'
grep -Fq 'Intel macOS is not supported' "$fixture/intel-install.err" || \
  fail 'Intel macOS installer failure is not actionable'

cat >"$fake_uname_dir/ldd" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' 'ldd (Debian GLIBC 2.36-9+deb12u13) 2.36'
EOF
cat >"$fake_uname_dir/sw_vers" <<'EOF'
#!/usr/bin/env sh
[ "${1:-}" = -productVersion ]
printf '%s\n' '15.7.6'
EOF
cat >"$fake_uname_dir/curl" <<'EOF'
#!/usr/bin/env sh
echo 'installer reached the network unexpectedly' >&2
exit 99
EOF
chmod 0755 "$fake_uname_dir/ldd" "$fake_uname_dir/sw_vers" "$fake_uname_dir/curl"
old_macos_install_status=0
PATH="$fake_uname_dir:$PATH" HOME="$fixture/home" \
  CARTOGRAPH_FAKE_UNAME_S=Darwin CARTOGRAPH_FAKE_UNAME_M=arm64 "$UNIX_INSTALLER" \
  >"$fixture/old-macos-install.out" 2>"$fixture/old-macos-install.err" || \
  old_macos_install_status=$?
[[ "$old_macos_install_status" -eq 1 ]] || fail 'old macOS installer request was not rejected'
grep -Fq 'requires macOS 26 or newer' "$fixture/old-macos-install.err" || \
  fail 'old macOS installer failure is not actionable or happened after network access'

old_linux_install_status=0
PATH="$fake_uname_dir:$PATH" HOME="$fixture/home" \
  CARTOGRAPH_FAKE_UNAME_S=Linux CARTOGRAPH_FAKE_UNAME_M=x86_64 "$UNIX_INSTALLER" \
  >"$fixture/old-linux-install.out" 2>"$fixture/old-linux-install.err" || \
  old_linux_install_status=$?
[[ "$old_linux_install_status" -eq 1 ]] || fail 'old Linux installer request was not rejected'
grep -Fq 'requires glibc 2.41 or newer' "$fixture/old-linux-install.err" || \
  fail 'old Linux installer failure is not actionable or happened after network access'

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

space_binary_directory="$fixture/release path with spaces"
space_binary="$space_binary_directory/cartograph"
mkdir -p "$space_binary_directory"
cat >"$space_binary" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version)
    printf 'cartograph %s\n' "${CARTOGRAPH_SMOKE_FIXTURE_VERSION:?}"
    ;;
  --help)
    cat <<'HELP'
  index
  status
  find
  context
  graph
  affected
  review
  install
  uninstall
  serve
  doctor
  db
HELP
    ;;
  serve)
    echo 'serve requires --mcp' >&2
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod 0755 "$space_binary"
fixture_version="$(cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | select(.name == "cartograph-cli") | .version')"
CARTOGRAPH_SMOKE_FIXTURE_VERSION="$fixture_version" "$SMOKE_HELPER" "$space_binary" >/dev/null

echo 'Release workflow attestation, sharding, and pinned-image retry contracts passed.'
