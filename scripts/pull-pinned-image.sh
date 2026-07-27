#!/usr/bin/env bash

set -euo pipefail

IMAGE="${1:-}"
MAX_ATTEMPTS="${2:-4}"
DOCKER_BIN="${CARTOGRAPH_DOCKER_BIN:-docker}"
RETRY_DELAY_SECONDS="${CARTOGRAPH_IMAGE_PULL_RETRY_DELAY_SECONDS:-5}"

if [[ ! "$IMAGE" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
  echo 'usage: pull-pinned-image.sh <image@sha256:digest> [maximum-attempts]' >&2
  exit 2
fi
if [[ ! "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ || "$MAX_ATTEMPTS" -gt 10 ]]; then
  echo 'maximum attempts must be an integer from 1 through 10' >&2
  exit 2
fi
if [[ ! "$RETRY_DELAY_SECONDS" =~ ^[0-9]+$ || "$RETRY_DELAY_SECONDS" -gt 60 ]]; then
  echo 'CARTOGRAPH_IMAGE_PULL_RETRY_DELAY_SECONDS must be from 0 through 60' >&2
  exit 2
fi
if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
  echo 'Docker is unavailable for the pinned image pull' >&2
  exit 1
fi

if "$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[container-image] already available: $IMAGE"
  exit 0
fi

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  echo "[container-image] pull attempt $attempt/$MAX_ATTEMPTS: $IMAGE"
  if "$DOCKER_BIN" pull "$IMAGE"; then
    if "$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "[container-image] verified digest-pinned image: $IMAGE"
      exit 0
    fi
    echo '[container-image] pull returned success but the exact digest is unavailable' >&2
  fi
  if (( attempt < MAX_ATTEMPTS )); then
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

echo "[container-image] exhausted $MAX_ATTEMPTS pull attempts: $IMAGE" >&2
exit 1
