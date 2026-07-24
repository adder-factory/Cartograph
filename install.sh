#!/bin/sh
set -eu

REPO="${CARTOGRAPH_REPO:-adder-factory/cartograph}"
INSTALL_DIR="${CARTOGRAPH_INSTALL_DIR:-$HOME/.cartograph-cli}"
BIN_DIR="${CARTOGRAPH_BIN_DIR:-$HOME/.local/bin}"

if [ "${1:-}" = "--uninstall" ]; then
  # Project-local MCP registrations are intentionally left in place because
  # this installer cannot know which projects/agent hosts the user configured.
  # Run `cartograph uninstall --yes --target <host>` inside each project first.
  rm -f "$BIN_DIR/cartograph"
  rm -rf "$INSTALL_DIR"
  echo "Cartograph standalone install removed."
  exit 0
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "cartograph: unsupported OS '$os'" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "cartograph: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
target="${os}-${arch}"

version="${CARTOGRAPH_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" \
    | sed -n 's#.*/releases/tag/##p')"
fi
[ -n "$version" ] || { echo "cartograph: could not resolve latest release; set CARTOGRAPH_VERSION." >&2; exit 1; }
case "$version" in v*) ;; *) version="v$version" ;; esac

url="https://github.com/$REPO/releases/download/$version/cartograph-${target}.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Installing Cartograph $version ($target)..."
curl -fsSL "$url" -o "$tmp/cartograph.tar.gz" || {
  echo "cartograph: download failed: $url" >&2
  echo "cartograph: (no prebuilt for '$target'? install from source: https://github.com/$REPO#get-started)" >&2
  exit 1
}

# Verify the archive against the release's SHA256SUMS before extracting an
# executable onto PATH. Set CARTOGRAPH_SKIP_CHECKSUM=1 to bypass (not
# recommended). Uses sha256sum (Linux) or shasum -a 256 (macOS).
if [ "${CARTOGRAPH_SKIP_CHECKSUM:-}" != "1" ]; then
  sums_url="https://github.com/$REPO/releases/download/$version/SHA256SUMS"
  if ! curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS"; then
    echo "cartograph: could not fetch SHA256SUMS for verification ($sums_url)." >&2
    echo "cartograph: set CARTOGRAPH_SKIP_CHECKSUM=1 to install without verification." >&2
    exit 1
  fi
  expected="$(grep "cartograph-${target}.tar.gz" "$tmp/SHA256SUMS" | awk '{print $1}' | head -n1)"
  if [ -z "$expected" ]; then
    echo "cartograph: no checksum for cartograph-${target}.tar.gz in SHA256SUMS." >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/cartograph.tar.gz" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/cartograph.tar.gz" | awk '{print $1}')"
  else
    echo "cartograph: no sha256sum/shasum available to verify the download." >&2
    echo "cartograph: set CARTOGRAPH_SKIP_CHECKSUM=1 to install without verification." >&2
    exit 1
  fi
  if [ "$expected" != "$actual" ]; then
    echo "cartograph: CHECKSUM MISMATCH — refusing to install." >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
  echo "Verified checksum."
fi

dest="$INSTALL_DIR/versions/$version"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tmp/cartograph.tar.gz" -C "$dest" --strip-components=1

mkdir -p "$BIN_DIR"
ln -sf "$dest/bin/cartograph" "$BIN_DIR/cartograph"
ln -sfn "$dest" "$INSTALL_DIR/current"

echo "Installed to $dest"
echo "Linked     $BIN_DIR/cartograph"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add it:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo ""
echo "Run: cartograph --help"
echo ""
echo "PostgreSQL/ParadeDB project setup:"
echo "  cd /path/to/your/project"
echo "  cartograph db start --project-path ."
echo "  cartograph index ."
echo "  cartograph install --yes --target codex --location local"
echo ""
echo "Use --target claude or --target cursor for those agent hosts."
