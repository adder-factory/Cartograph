#!/usr/bin/env bash

set -euo pipefail

STAGE="${1:-}"
BINARY="${2:-}"
if [[ -z "$STAGE" || -z "$BINARY" || ! -d "$STAGE" || ! -f "$BINARY" ]]; then
  echo "usage: $0 <release-stage> <source-binary>" >&2
  exit 2
fi

EXPECTED_FILES=$'ACKNOWLEDGEMENTS.md\nLICENSE\nREADME.md\nbin/cartograph\nshare/cartograph/PARADEDB-NOTICE.md'
ACTUAL_FILES="$(cd "$STAGE" && find . -type f -print | sed 's#^./##' | LC_ALL=C sort)"
if [[ "$ACTUAL_FILES" != "$EXPECTED_FILES" ]]; then
  echo "release archive allowlist mismatch" >&2
  diff -u <(printf '%s\n' "$EXPECTED_FILES") <(printf '%s\n' "$ACTUAL_FILES") >&2 || true
  exit 1
fi

if find "$STAGE" -type l -print -quit | grep -q .; then
  echo "release stage contains a symbolic link" >&2
  exit 1
fi

for PRIVATE_FRAGMENT in "$PWD" "${HOME:-}" '/Users/' '/home/runner/work/'; do
  [[ -n "$PRIVATE_FRAGMENT" ]] || continue
  if strings "$BINARY" | grep -Fq "$PRIVATE_FRAGMENT"; then
    echo "release binary contains a private build-root fragment" >&2
    exit 1
  fi
done

if find "$STAGE" -type f \( -name '*.so' -o -name '*.dylib' -o -name '*.dll' -o -name '*.sql' -o -name '*.tar' -o -name '*.tar.gz' -o -name '*.img' \) -print -quit | grep -q .; then
  echo "release stage contains a forbidden database/extension artifact" >&2
  exit 1
fi

if cargo tree --locked --workspace --all-features -e normal | grep -Eiq '(^|[-_ ])(sqlite|libsqlite)'; then
  echo "Cartograph v2 release dependency graph contains SQLite" >&2
  exit 1
fi

TRACKED_LEGACY="$({
  git ls-files '*.ts' '*.tsx' '*.js' '*.jsx' '*.mts' '*.cts' '*.mjs' '*.cjs'
} | grep -Ev '^(crates/cartograph-indexer/tests/fixtures/native_corpus_v1/|crates/cartograph-extract/tests/fixtures/v1_1_33/|docs/test-beds/)' || true)"
if [[ -n "$TRACKED_LEGACY" ]]; then
  echo "Cartograph v2 tracks executable legacy runtime source outside frozen fixtures" >&2
  printf '%s\n' "$TRACKED_LEGACY" >&2
  exit 1
fi

for LEGACY_MANIFEST in package.json package-lock.json bun.lock bunfig.toml tsconfig.json biome.json; do
  if git ls-files --error-unmatch "$LEGACY_MANIFEST" >/dev/null 2>&1; then
    echo "Cartograph v2 tracks legacy runtime manifest $LEGACY_MANIFEST" >&2
    exit 1
  fi
done

if git ls-files 'src/**' '__tests__/**' 'bench/**' | grep -q .; then
  echo "Cartograph v2 still tracks the executable v1 source/test/bench tree" >&2
  exit 1
fi

echo "[rust-release] archive allowlist, privacy, license, native-runtime, and no-SQLite checks passed"
