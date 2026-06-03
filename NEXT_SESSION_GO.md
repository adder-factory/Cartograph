# Next Session: `go`

When the user says exactly `go`, read this file and start the first
unchecked task below.

The goal of the next session is not another one-off friction sweep. The
goal is to reduce the structural causes of the bugs found in the
MCP/CLI/Sonar work: duplicated contracts, CLI/MCP drift, implicit
installer states, subtle graph invariants, partial test mocks, and CI
portability gaps.

## Current State

- Branch: `main`
- Latest verified code/CI commit before this handoff update:
  `9baef95 ci: bump checkout and setup-node actions`
- Worktree at handoff: clean, `main...origin/main`
- Cartograph is initialized in this repo; use Cartograph MCP tools for
  code exploration before broad file reads.
- Latest GitHub Actions run:
  - Run `26917926526`
  - Status: success
  - Passed: checkout/setup-node v6, install, typecheck, Biome, module
    leak canaries, biomarker floor
- Latest Sonar run after source/test changes:
  - CE task `4e39e8ca-ba00-4f23-b5dc-3e80678edccf`
  - Analysis `59db8bcc-dc47-4b2e-bcd7-e9ef748ed8e7`
  - Quality gate `OK`
  - Open/confirmed issues `0`
  - Coverage `90.0%`
  - New coverage `91.0%`
  - New violations `0`
  - Note: the final commit after that Sonar run only changed
    `.github/workflows/check.yml`, outside Sonar source/test scope.

Recent relevant commits:

- `9baef95 ci: bump checkout and setup-node actions`
- `e0dc0ba test: remove remaining partial leak mocks`
- `a7973b2 test: preserve exports in leak canary mocks`
- `dd5f1d6 ci: make leak canary discovery portable`
- `8a00c9d ci: run module leak canaries`
- `6943a08 fix(tests-for): guard barrel traversal regressions`
- `e913b84 fix(installer): improve doctor and setup guidance`
- `cb9f14a fix(cli-mcp): smooth tool surface frictions`

## Why We Had So Many Bugs

The failures were mostly structural, not isolated mistakes:

- MCP schemas, generated CLI flags, hand-written command families, help
  text, aliases, defaults, examples, and validation are not all derived
  from one authoritative contract.
- CLI and MCP argument handling have overlapping but separate paths,
  which allowed drift in boolean negation, unknown-argument handling,
  enum/action errors, and output hints.
- Installer/doctor behavior has many implicit valid states:
  uninitialized, initialized without LLM config, no-models setup,
  minimal models, full models, detected local backend, cloud backend,
  skip-project-checks, and env model dir override.
- Graph-facing tools depend on subtle invariants around file nodes,
  side-effect imports, barrels, reverse dependencies, affected tests,
  symbol mode, and file mode.
- Several tests used partial top-level `vi.mock()` calls for shared
  modules. That passed in some local orders but poisoned later MCP
  canaries in CI.
- CI scripts assumed local tools such as `rg`; GitHub runners did not
  provide them.

## Start Here

1. Run `git status --short --branch`.
2. Confirm the repo is clean and inspect any newer user changes before
   editing.
3. Use Cartograph for project-aware exploration.
4. Work the unchecked tasks below in order unless the user redirects.
5. Keep edits scoped and add contract tests with each behavior change.
6. Before reporting done, run `cartograph_compare_to_ref`.
7. If code changed, run focused tests, `npm run typecheck`, Biome,
   `npm run test:leaks` when test/mocking/tool-surface code changed,
   Sonar when source/test behavior changed, then commit and push.

## Task 1: Canonical Tool Contract

- [ ] Identify the current canonical-ish tool definition path and where
  CLI metadata is generated from it.
- [ ] Design a single `ToolContract` shape that can drive:
  - MCP input schema
  - CLI flags and aliases
  - CLI help text
  - default values
  - boolean negation text and behavior
  - examples and next-step hints
  - generated CLI/MCP parity tests
- [ ] Move one low-risk generated command family onto the contract shape
  as a pilot, preferably a read-only tool with booleans and enums.
- [ ] Add tests proving generated CLI flags, MCP schema, defaults, and
  help snippets come from the same source.
- [ ] Document the contract shape for future tools.

Likely starting points:

- `src/mcp/tool-types.ts`
- `src/mcp/tools.ts`
- `src/bin/_command-generator.ts`
- `src/bin/commands/generated.ts`
- `__tests__/command-generator.test.ts`
- `__tests__/cli-mcp-alignment.test.ts`

## Task 2: Shared Argument Normalization

- [ ] Inventory where MCP and CLI currently handle aliases, defaults,
  booleans, negation, enum validation, and unknown arguments.
- [ ] Add or extract one shared normalization pipeline:
  `raw args -> aliases -> boolean negation -> defaults -> validation -> normalized args`.
- [ ] Make generated CLI and MCP tools use the same normalization where
  feasible.
- [ ] Standardize unknown-argument behavior:
  either schema rejection or structured warning, but not silent drift.
- [ ] Add contract tests for:
  - `includeTests: false` style booleans
  - `--no-*` CLI flags
  - invalid enum/action values
  - ignored/unknown argument reporting
  - explicit call values overriding defaults

Likely starting points:

- `src/bin/_cli-core.ts`
- `src/bin/_command-generator.ts`
- `src/mcp/tools.ts`
- `src/mcp/tool-types.ts`
- `__tests__/cli-mcp-alignment.test.ts`
- `__tests__/command-generator.test.ts`

## Task 3: Generated Tool-Surface Contract Matrix

- [ ] Turn the existing CLI/MCP parity checks into an explicit generated
  matrix for every registered tool.
- [ ] For each tool, cover:
  - MCP minimal valid call
  - CLI `--help`
  - CLI/MCP default parity
  - invalid enum/action error shape
  - unknown argument behavior
  - JSON/text output sanity where applicable
- [ ] Keep the test output readable so failures point to the exact tool,
  field, and surface.
- [ ] Decide whether the matrix belongs in existing tests or a new
  focused `tool-contract` test file.

Likely starting points:

- `__tests__/tool-surface-smoke.test.ts`
- `__tests__/cli-mcp-alignment.test.ts`
- `__tests__/command-generator.test.ts`
- `src/mcp/tools.ts`
- `src/bin/_command-generator.ts`

## Task 4: Installer/Doctor State Machine

- [ ] Define explicit installer/doctor states:
  - uninitialized
  - initialized without LLM config
  - setup with `--no-models`
  - minimal models
  - full models
  - detected local backend
  - cloud/OpenAI-compatible backend
  - skip project checks
  - env model dir override
- [ ] Encode the expected checks, statuses, and remediation messages for
  each state.
- [ ] Add table-driven tests for CLI and MCP admin surfaces.
- [ ] Make doctor output avoid contradictory guidance, especially around
  bring-your-own-backend and no-model workflows.

Likely starting points:

- `src/installer/doctor.ts`
- `src/installer/index.ts`
- `src/installer/llm-setup-plan.ts`
- `src/installer/recommended-config.ts`
- `src/bin/commands/admin.ts`
- `src/bin/commands/lifecycle.ts`
- `src/mcp/tools/admin.ts`
- `__tests__/doctor-embedding-reachability.test.ts`
- `__tests__/llm-setup-plan.test.ts`
- `__tests__/recommended-config.test.ts`
- `__tests__/admin-command-actions-unit.test.ts`
- `__tests__/lifecycle-command-actions-unit.test.ts`

## Task 5: Graph Invariant Suite

- [ ] Add a small invariant fixture for graph/file/test relationships.
- [ ] Assert these invariants:
  - resolved imports create reverse dependent paths
  - side-effect imports still count as dependencies
  - barrels are capped and warned in file mode
  - symbol mode avoids barrel fanout
  - `affected` and `tests_for` agree on common fixture paths
  - definition locations and call-site locations are not mixed
- [ ] Keep the fixtures small enough for fast local and CI runs.

Likely starting points:

- `src/graph/queries.ts`
- `src/mcp/tools/tests-for.ts`
- `src/mcp/tools/affected.ts` or affected-test implementation files
- `src/mcp/tools/graph.ts`
- `src/mcp/tools/at-range.ts`
- `src/review/index.ts`
- `__tests__/graph.test.ts`
- `__tests__/mcp-affected.test.ts`
- `__tests__/mcp-tests-for.test.ts`
- `__tests__/at-range.test.ts`
- `__tests__/review-context.test.ts`

## Task 6: Mock Hygiene Guardrail

- [ ] Keep `npm run test:leaks` in CI.
- [ ] Add a lightweight static rule or script warning for partial
  top-level mocks of shared source modules.
- [ ] Preferred policy:
  - use `vi.spyOn(realModule, ...)`
  - avoid `vi.mock('../src/shared-module', () => ({ onlyOneExport }))`
  - if a full module mock is unavoidable, preserve every real export or
    isolate the test process deliberately
- [ ] Audit the remaining top-level `vi.mock()` tests and convert any
  shared-module partial mocks that are likely to poison MCP canaries.

Likely starting points:

- `scripts/check-test-module-leaks.mjs`
- `__tests__/edge-resolution-helpers-unit.test.ts`
- `__tests__/extraction-store-phases-unit.test.ts`
- `__tests__/value-ref-edges-hook-unit.test.ts`
- `__tests__/cochange-hook-unit.test.ts`
- `__tests__/watcher.test.ts`

## Task 7: CI Portability Rule

- [ ] Add a short repo convention for scripts used in CI:
  nonstandard tools must either be installed by the workflow or have a
  fallback.
- [ ] Add a smoke test or script self-check for CI scripts that depend on
  local-only binaries.
- [ ] Keep `rg` as the preferred local path, but fall back to `git grep`
  or Node APIs where appropriate.

Likely starting points:

- `scripts/check-test-module-leaks.mjs`
- `.github/workflows/check.yml`
- `package.json`
- `README.md`

## Definition of Done

- [ ] Structural changes implemented with focused tests.
- [ ] CLI/MCP contracts are harder to drift.
- [ ] Installer/doctor states are explicit and table-tested.
- [ ] Graph invariants are covered by small fixtures.
- [ ] Partial top-level mocks are either removed or guarded.
- [ ] CI scripts are portable on GitHub runners.
- [ ] `npm run typecheck` passes.
- [ ] `bunx biome check ...` passes on edited files.
- [ ] Relevant focused tests pass.
- [ ] `npm run test:leaks` passes if test/mocking/tool-surface code changed.
- [ ] GitHub Actions is green after push.
- [ ] Sonar quality gate is green if source/test behavior changed.
- [ ] `cartograph_compare_to_ref({findingsDelta:true})` shows no
  introduced high-risk findings, or findings are explained.
- [ ] Commit and push.
