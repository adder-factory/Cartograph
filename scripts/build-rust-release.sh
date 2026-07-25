#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
ASSET_TARGET="${2:-}"

if [[ -z "$TARGET" || -z "$ASSET_TARGET" ]]; then
  echo "usage: $0 <rust-target-triple> <asset-target>" >&2
  exit 2
fi

case "$ASSET_TARGET" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *)
    echo "unsupported release asset target: $ASSET_TARGET" >&2
    exit 2
    ;;
esac

RELEASE_DIR="$ROOT/release"
STAGING_ROOT="$RELEASE_DIR/.staging"
STAGE_NAME="cartograph-$ASSET_TARGET"
STAGE="$STAGING_ROOT/$STAGE_NAME"
ARCHIVE="$RELEASE_DIR/$STAGE_NAME.tar.gz"
DIRECT="$RELEASE_DIR/$STAGE_NAME"
BINARY="$ROOT/target/$TARGET/release/cartograph"

# Rust panic locations and vendored C/C++ grammar diagnostics retain source
# paths unless both toolchains are remapped. The archive audit below verifies
# that none of these runner-owned roots survive in the published binary.
append_encoded_rust_flag() {
  local flag="$1"
  local separator=$'\x1f'
  if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
    CARGO_ENCODED_RUSTFLAGS+="$separator"
  fi
  CARGO_ENCODED_RUSTFLAGS+="$flag"
}

if [[ -z "${CARGO_ENCODED_RUSTFLAGS:-}" && -n "${RUSTFLAGS:-}" ]]; then
  read -r -a inherited_rust_flags <<<"$RUSTFLAGS"
  for inherited_rust_flag in "${inherited_rust_flags[@]}"; do
    append_encoded_rust_flag "$inherited_rust_flag"
  done
fi
unset RUSTFLAGS

PRIVATE_BUILD_ROOTS=(
  "$ROOT"
  "${HOME:-}"
  "${CARGO_HOME:-}"
  "${RUSTUP_HOME:-}"
  "${GITHUB_WORKSPACE:-}"
  "${RUNNER_WORKSPACE:-}"
)
for private_root in "${PRIVATE_BUILD_ROOTS[@]}"; do
  [[ -n "$private_root" ]] || continue
  append_encoded_rust_flag "--remap-path-prefix=$private_root=."
  CFLAGS="${CFLAGS:+$CFLAGS }-ffile-prefix-map=$private_root=."
  CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }-ffile-prefix-map=$private_root=."
done
export CARGO_ENCODED_RUSTFLAGS CFLAGS CXXFLAGS

cargo build --locked --release --package cartograph-cli --target "$TARGET"

rm -rf "$STAGE" "$ARCHIVE" "$DIRECT"
mkdir -p "$STAGE/bin" "$STAGE/share/cartograph"
install -m 0755 "$BINARY" "$STAGE/bin/cartograph"
install -m 0644 "$ROOT/LICENSE" "$STAGE/LICENSE"
install -m 0644 "$ROOT/README.md" "$STAGE/README.md"
install -m 0644 "$ROOT/ACKNOWLEDGEMENTS.md" "$STAGE/ACKNOWLEDGEMENTS.md"
install -m 0644 "$ROOT/docs/v2/LICENSING.md" "$STAGE/share/cartograph/PARADEDB-NOTICE.md"

"$ROOT/scripts/smoke-rust-release.sh" "$STAGE/bin/cartograph"
"$ROOT/scripts/audit-rust-release.sh" "$STAGE" "$BINARY"

tar -czf "$ARCHIVE" -C "$STAGING_ROOT" "$STAGE_NAME"
install -m 0755 "$BINARY" "$DIRECT"
"$ROOT/scripts/smoke-rust-release.sh" "$DIRECT"
echo "[rust-release] wrote $ARCHIVE and $DIRECT"
