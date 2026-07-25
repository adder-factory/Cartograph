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
