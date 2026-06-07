#!/bin/sh
set -eu

REPO="${CARTOGRAPH_REPO:-adder-factory/cartograph}"
INSTALL_DIR="${CARTOGRAPH_INSTALL_DIR:-$HOME/.cartograph-cli}"
BIN_DIR="${CARTOGRAPH_BIN_DIR:-$HOME/.local/bin}"

if [ "${1:-}" = "--uninstall" ]; then
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
  exit 1
}

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
echo "Agent-friendly project setup:"
echo "  cd /path/to/your/project"
echo "  cartograph install --yes --target=auto --location=local"
echo "  cartograph status --verbose"
