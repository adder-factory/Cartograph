#!/usr/bin/env bash
# Release/pre-release audit bundle for the bug/friction classes that
# tend to drift across MCP, CLI, schema, and code-health surfaces.

set -euo pipefail

echo "== typecheck =="
bun run typecheck

echo "== architecture gate =="
bun run check:architecture

echo "== biome check =="
bun run check:biome

echo "== MCP load budget =="
bun run check:mcp-load

echo "== biomarkers =="
bun run check:biomarkers

echo "== viewer smoke =="
bun run test:viewer-smoke:required

echo "== fast test suite =="
bun run test:fast
