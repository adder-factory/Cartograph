# Next Session: `go`

When the user says exactly `go`, read this file and start the first
unchecked task below. The repo is already clean and pushed at the time
of this handoff; do not redo the completed low-token/MCP-load work
unless a new test failure points back to it.

## Current State

- Branch: `main`
- Latest completed implementation commit before this handoff:
  `7f29e93 Reduce MCP load context`
- Worktree at handoff: clean, `main...origin/main`
- Cartograph is initialized in this repo; use Cartograph MCP tools for
  code exploration before broad file reads.

Completed in the previous session:

- Added `lowTokens` support for high-volume MCP tools:
  `find`, `graph`, `context`, `explore`, `at_range`, `node`, `files`,
  and `imports`.
- Added matching `--low-tokens` CLI flags where needed and verified
  CLI/MCP alignment.
- Added `bun run benchmark:tokens` and README benchmark table.
- Reduced MCP startup/load context by compacting advertised
  `tools/list` descriptions only; full internal schemas and CLI help
  remain intact.
- Added a registry budget guard:
  - max 45 advertised MCP tools
  - max 65 KB serialized `tools/list`
  - max 80 KB combined `tools/list` + initialize instructions
- Updated README, playbook/server instructions, generated agent
  instructions, and CLI `serve --help`.

Measured after Task 4:

- Full MCP server: 36 tools.
- Full `tools/list`: ~16,076 estimated tokens.
- Compact initialize guide: ~447 estimated tokens.
- Full MCP load including compact initialize guide: ~16,522 estimated
  tokens.
- Full playbook remains available through `cartograph_playbook`: ~2,870
  estimated tokens.
- With `--no-write-tools`: 31 tools, combined load ~13,584 estimated
  tokens.
- Per-call `lowTokens` benchmark average: ~57% less output than regular
  Cartograph on the measured cases.
- `cartograph mcp-budget` / `bun run measure:mcp-load` now reports
  tool count, `tools/list`, initialize, combined startup load, on-demand
  full playbook size, and top schema contributors.
- `bun run check:mcp-load` now prints the same MCP load report with an
  explicit PASS/FAIL line and exits non-zero when hard limits are
  exceeded.

Verification already passed:

- `npm run typecheck`
- `bun test --timeout 30000 __tests__/mcp-low-tokens.test.ts __tests__/cli-mcp-alignment.test.ts __tests__/cli-read-internals.test.ts __tests__/mcp-tool-registry.test.ts`
- `bun test --timeout 30000 __tests__/mcp-tool-registry.test.ts __tests__/mcp-server-options.test.ts __tests__/mcp-server-coverage.test.ts`
- `bunx biome check src/mcp/tools.ts __tests__/mcp-tool-registry.test.ts src/bin/commands/lifecycle.ts src/mcp/server-instructions.ts src/installer/instructions-template.ts README.md`
- `bun run benchmark:tokens`
- `cartograph_compare_to_ref({ref:"HEAD", includeBiomarkers:true, findingsDelta:true})`
- Sonar scanner submitted successfully; CE `SUCCESS`, quality gate `OK`,
  and `new_open_confirmed_issues_since_2026-06-03=0`.

Sonar notes:

- Use `SONAR_TOKEN` from the environment without printing it.
- This SonarQube 26.5 server accepted current APIs:
  - `/api/ce/task?id=...`
  - `/api/qualitygates/project_status?analysisId=...`
  - `/api/issues/search?...&issueStatuses=OPEN,CONFIRMED`
- Do not use deprecated `statuses`; do not assume `/api/v2/...` exists
  here because it returned 404 in the previous session.

## Start Here

1. Run `git status --short --branch`.
2. Confirm the repo is clean and inspect any newer user changes before
   editing.
3. Use Cartograph for project-aware exploration.
4. Work the unchecked tasks below in order.
5. Keep edits scoped, update docs/playbook/help with each behavior
   change, and run focused tests after each task.
6. Before reporting done, run `cartograph_compare_to_ref`.
7. If code changed, run typecheck, Biome, relevant tests, benchmark if
   token behavior changed, Sonar, then commit and push.

## Task 1: MCP Serve Profiles

- [x] Add an MCP server profile option, likely
  `cartograph serve --mcp --profile <full|core|read-only|review>`.
- [x] Make the default profile preserve current behavior (`full`) unless
  the user explicitly chooses another profile.
- [x] Implement profiles as advertised-tool filters, not as new MCP
  tools, so the registry count stays stable.
- [x] Define conservative initial profiles:
  - `full`: current 36-tool surface.
  - `core`: focused coding-agent surface for common lookups and edits.
  - `read-only`: no write-class tools; should align with or build on
    existing `--no-write-tools`.
  - `review`: diff/risk/test/change-impact oriented surface.
- [x] Ensure profiles compose predictably with repeated
  `--disable-tool <name>` and `--no-write-tools`.
- [x] Update `cartograph_status` server-config output so agents can see
  the active profile.
- [x] Add tests for profile filtering, composition, and MCP load-budget
  impact.

Likely starting points:

- `src/bin/commands/lifecycle.ts`
- `src/mcp/index.ts`
- `src/mcp/tools.ts`
- `src/mcp/tools/status.ts`
- `__tests__/mcp-server-options.test.ts`
- `__tests__/mcp-tool-registry.test.ts`

## Task 2: Low-Tokens Default

- [x] Add a server option such as
  `cartograph serve --mcp --low-tokens-default`.
- [x] When enabled, supported high-volume tools behave as if
  `lowTokens: true` was passed unless the caller explicitly passes
  `lowTokens: false`.
- [x] Keep unsupported tools unchanged.
- [x] Surface the active default in `cartograph_status` server-config
  output.
- [x] Add tests proving explicit per-call `lowTokens` wins over the
  server default.
- [x] Update CLI help, README, playbook/server instructions, and
  generated agent instructions.

Likely starting points:

- `src/mcp/tools.ts`
- `src/mcp/tools/find.ts`
- `src/mcp/tools/graph.ts`
- `src/mcp/tools/context.ts`
- `src/mcp/tools/explore.ts`
- `src/mcp/tools/at-range.ts`
- `src/mcp/tools/node.ts`
- `src/mcp/tools/files.ts`
- `src/mcp/tools/imports.ts`
- `src/bin/commands/lifecycle.ts`
- `src/mcp/tools/status.ts`
- `__tests__/mcp-low-tokens.test.ts`
- `__tests__/mcp-server-options.test.ts`

## Task 3: Shorter Initialize Playbook

- [x] Reduce `SERVER_INSTRUCTIONS` startup text further while keeping
  enough guidance for correct first-tool selection.
- [x] Move detailed guidance behind `cartograph_playbook` if needed,
  or split a compact initialize instruction from the full playbook.
- [x] Keep `cartograph_playbook` useful as the complete guide.
- [x] Update tests that assert playbook/initialize equivalence if the
  surfaces intentionally diverge.
- [x] Re-measure combined MCP load context and tighten the regression
  budget if practical.

Likely starting points:

- `src/mcp/server-instructions.ts`
- `src/mcp/tools/playbook.ts`
- `src/index.ts`
- `__tests__/mcp-tool-registry.test.ts`
- `__tests__/mcp-server-coverage.test.ts`

## Task 4: Budget Visibility

- [x] Add a small script or CLI diagnostic for MCP load budget, e.g.
  `scripts/measure-mcp-load.ts` or `cartograph mcp-budget`.
- [x] Report tool count, `tools/list` chars/tokens, initialize
  chars/tokens, combined load, and top schema contributors.
- [x] Wire it into docs and optionally package scripts.
- [x] Keep the existing registry test as the hard guard.

Likely starting points:

- `scripts/benchmark-token-savings.ts`
- `package.json`
- `README.md`
- `__tests__/mcp-tool-registry.test.ts`

## Task 5: MCP Load CI Visibility

- [x] Add a CI-friendly MCP load-budget check around the shared
  measurement helper.
- [x] Print a clear budget report before failing so contributors see
  the largest schema contributors.
- [x] Wire the check into package scripts and README.
- [x] Cover PASS and FAIL semantics in tests.

## Definition of Done

- [x] New behavior implemented and documented in README.
- [x] Playbook/server instructions updated.
- [x] Generated agent instructions updated.
- [x] CLI help updated and tested.
- [x] MCP and CLI remain aligned where applicable.
- [x] MCP load-budget guard still passes.
- [x] Focused tests pass.
- [x] `npm run typecheck` passes.
- [x] `bunx biome check ...` passes on edited files.
- [x] `bun run benchmark:tokens` rerun if token-result behavior changed.
- [x] Sonar run is green if code changed.
- [x] `cartograph_compare_to_ref({findingsDelta:true})` shows no
  introduced high-risk findings, or findings are explained.
- [x] Commit and push.
