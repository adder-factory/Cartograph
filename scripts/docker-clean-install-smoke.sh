#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${CARTOGRAPH_DOCKER_IMAGE:-oven/bun:1.3}"
REQUIRED="${CARTOGRAPH_DOCKER_CLEAN_INSTALL_REQUIRED:-0}"

if ! command -v docker >/dev/null 2>&1; then
  if [ "$REQUIRED" = "1" ]; then
    echo "docker-clean-install-smoke: docker is not available" >&2
    exit 1
  fi
  echo "docker-clean-install-smoke: skipped (docker is not available)"
  exit 0
fi

docker run --rm \
  -v "$ROOT:/src:ro" \
  -v cartograph-bun-cache:/root/.bun/install/cache \
  "$IMAGE" \
  sh -lc '
    set -eu
    work=/tmp/cartograph-clean-install
    fixture=/tmp/cartograph-clean-fixture
    rm -rf "$work" "$fixture"
    mkdir -p "$work" "$fixture/src"

    cd /src
    tar \
      --exclude=.git \
      --exclude=node_modules \
      --exclude=.cartograph \
      --exclude=dist \
      -cf - . | tar -xf - -C "$work"

    cd "$work"
    bun install --frozen-lockfile
    bun link
    export PATH="${BUN_INSTALL:-/root/.bun}/bin:$PATH"
    cartograph --version >/tmp/cartograph-version.txt

    cat > "$fixture/package.json" <<\EOF
{"name":"cartograph-clean-fixture","type":"module"}
EOF
    cat > "$fixture/src/index.ts" <<\EOF
export function greet(name: string): string {
  return `hello ${name}`;
}
EOF

    cartograph setup --no-models "$fixture"
    test -d "$fixture/.cartograph"
    cartograph admin index --quiet "$fixture"
    cartograph doctor --json "$fixture" > /tmp/cartograph-doctor.json
    grep -q "\"overallStatus\"" /tmp/cartograph-doctor.json
    echo "docker-clean-install-smoke: passed with $(cat /tmp/cartograph-version.txt)"
  '
