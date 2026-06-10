#!/usr/bin/env bash
# Curated serial pure-unit test subset for CI.
#
# The full parallel-shard suite is excluded from CI (Bun bus-errors under
# parallel native-worker load), but these deterministic, index-free,
# worker-free unit tests run serially with no bus-error risk and catch
# functional regressions that typecheck/biome/biomarkers miss. Expand the
# list incrementally.
set -euo pipefail

export CARTOGRAPH_HOOKS_IN_PROCESS=1

bun test --isolate \
  __tests__/postgres-worker-sql.test.ts \
  __tests__/tool-schema-defaults.test.ts \
  __tests__/schema-parity.test.ts \
  __tests__/framework-anchor-uniqueness.test.ts \
  __tests__/edge-confidence.test.ts \
  __tests__/path-class.test.ts \
  __tests__/import-classifier.test.ts \
  __tests__/define-tool.test.ts \
  __tests__/daemon-logic-unit.test.ts \
  __tests__/search-query-parser.test.ts
