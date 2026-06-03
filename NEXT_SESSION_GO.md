# Next Session: `go`

When the user says exactly `go`, start this task list. Do not re-open
the completed clean-git content-drift fix unless a new test failure
points back to it.

## Current State

- The active patch fixes the clean-git `contentDriftedFiles > 0`
  freshness bug and adds regression coverage.
- Verification already passed before this handoff:
  - `npm test` passed: 4,932 pass, 0 fail, 18 skip.
  - `npm run typecheck` passed.
  - `biome check` passed on edited TS/test files.
  - `git diff --check` passed.
  - `cartograph_compare_to_ref` reported 0 introduced biomarker findings.

## Start Here

1. Run `git status --short` and read this file plus `TASKS.md`.
2. Use Cartograph for code exploration because `.cartograph/` exists.
3. Work the tasks below in order, one patch at a time.
4. After each task, run focused tests plus `npm run typecheck`.
5. Before reporting done, run `cartograph_compare_to_ref`.

## Task 1: Symbol Disambiguation UX

Problem: common symbol names such as `sync` currently resolve to one
candidate while mentioning alternatives. The tool output should make
the next step obvious without manual file reads.

Acceptance criteria:

- Ambiguous symbol lookups show a compact candidate list with stable
  node id, name, kind, file, line, and enough context to choose.
- The output includes an explicit follow-up example using the stable
  node id, such as `cartograph_node({symbol: "n_xxxxxxxx"})`.
- Apply this where ambiguity is most painful first, likely symbol
  resolution paths used by `cartograph_node` and graph navigation.
- Add regression tests for an ambiguous name such as `sync`.

Likely starting points:

- `src/mcp/tools/symbol-resolver.ts`
- `src/mcp/tools/node.ts`
- `src/mcp/tools.ts`
- `__tests__/mcp-node-multi.test.ts`

## Task 2: Task-Scoped Review Filters

Problem: `cartograph_review mode=risk` is useful but too broad for
focused work. A freshness task should be able to reduce unrelated
hotspot, dead-code, and coverage noise.

Acceptance criteria:

- Add a simple scoped filter first, preferably `pathFilter` for
  `mode: "risk"`.
- Apply it consistently to risk lenses where path filtering is
  meaningful: biomarkers, hotspots, coverage gaps, and dead-code
  candidates.
- Document the new argument in the tool schema description.
- Add tests showing unrelated paths are excluded.

Likely starting points:

- `src/mcp/tools/review.ts`
- `src/mcp/tools/review-risk.ts` or adjacent review modules
- `__tests__/mcp-risk-review.test.ts`

## Task 3: Shared Freshness-Risk Helper

Problem: freshness-risk semantics now include
`contentDriftedFiles > 0`, but related logic is still spread across
MCP gating, metadata, status rendering, empty-result hints, and CLI
generated wrappers.

Acceptance criteria:

- Extract a small shared helper for "has freshness risk" and
  "recommended action" semantics.
- Preserve current behavior for `isStale`, `contentDriftedFiles`,
  heavy drift, `allowStale`, and auto-sync metadata.
- Update MCP gating and empty-result hints to use the helper.
- Update status/CLI surfaces only where the helper clearly reduces
  duplicated logic without changing user-visible behavior.
- Add or adjust focused regression tests around clean-git content drift.

Likely starting points:

- `src/freshness.ts`
- `src/mcp/tools.ts`
- `src/mcp/tools/shared.ts`
- `src/mcp/tools/status.ts`
- `src/bin/commands/generated.ts`
- `__tests__/freshness.test.ts`
- `__tests__/mcp-status-b14.test.ts`

## Task 4: Unresolved Refs Explainability

Problem: `cartograph_status` can show a large `Unresolved refs` count
that is healthy but easy to misread as corruption. The current status
line says it is intentional, but it does not give users a quick way to
understand what the tail contains.

Acceptance criteria:

- Add a lightweight drilldown or status detail that buckets unresolved
  refs by `reference_kind` and `language`.
- Include a small sample of common unresolved names, preferably capped
  and sorted by frequency.
- Keep the existing corruption/degraded-edge warning separate from the
  healthy unresolved-tail disclosure.
- Avoid making normal unresolved refs look like failures; use an
  informational tone and explain common causes such as builtins,
  external APIs, property access, framework hooks, and dynamic dispatch.
- Add focused tests for the rendering and threshold behavior.

Likely starting points:

- `src/mcp/tools/status.ts`
- `src/db/queries-unresolved-refs.ts`
- `__tests__/mcp-status.test.ts`
- `__tests__/mcp-status-b14.test.ts`
