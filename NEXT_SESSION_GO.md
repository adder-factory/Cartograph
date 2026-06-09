# Next Session: `go`

When the user says exactly `go`, read this file first and begin the first
unchecked task below.

## Current State

The CLI/MCP consolidation work is landed and pushed on `main`.

Latest pushed commit:

- `d79cd9c fix: remove retired CLI shortcuts`

Recent related commits:

- `7190b58 fix: align CLI aliases with MCP modes`
- `140e681 feat: consolidate MCP tool families`

The worktree was clean after `d79cd9c` was pushed.

## What Just Changed

The retired top-level CLI shortcuts are no longer registered:

- `cartograph local-chat`
- `cartograph dependency-coverage`
- `cartograph discover`
- `cartograph host-diagnostics`

Canonical CLI/MCP-aligned forms remain:

- `cartograph ask --mode local_chat`
- `cartograph deps --mode coverage`
- `cartograph host --mode discover`
- `cartograph host --mode diagnostics`

Docs/help/playbook updates were included:

- README command map
- `docs/CLI-REFERENCE.md`
- `docs/MCP-USAGE.md`
- `docs/cli-mcp-alignment.md`
- `src/mcp/server-instructions.ts` (`cartograph_playbook`)
- schema-guard stale-server recovery text

## Verification Already Run

For `d79cd9c`:

- `npm run typecheck` passed.
- Focused command/docs/playbook tests passed: `141 pass / 0 fail`.
- `npm run check` passed.
- `npm run check:mcp-load` passed.
- `npm run check:biomarkers` passed: `0 error / 0 warning / 0 info`.
- `npm run test:fast` passed: `5619 pass / 0 fail / 28 skip`.
- `bun src/bin/cartograph.ts compare-to-ref --findings-delta --include-biomarkers`
  reported `0` introduced per-file biomarker findings.
- Sonar scanner succeeded and quality gate was `OK`.
  - CE task: `780c98a4-6de4-4ea7-bbbe-6aa4026f819e`
  - Analysis: `5b95e1e4-6e1e-4878-9360-1d44696e338c`

Manual CLI checks confirmed the retired commands fail as unknown commands and
canonical command help exposes the relevant `--mode` flags.

## First Checklist

- [ ] Re-check `git status --short` and confirm the session starts clean.
- [ ] Read `AGENTS.md` and `docs/ARCHITECTURE.md`; preserve the feature-slice
      shape.
- [ ] If continuing CLI/MCP alignment, audit the remaining intentional CLI-only
      shortcuts before editing:
      - `file-deps`
      - `file-symbols`
      - `module`
      - `similar`
      - `doctor`
      - `sync-if-dirty`
- [ ] For `file-deps`, `file-symbols`, and `module`, first verify whether the
      canonical `cartograph files --format deps|symbols|module` CLI paths are
      behaviorally equivalent and ergonomic enough. If they are, consider
      retiring those top-level shortcuts the same way the 2026-06-09 shortcuts
      were retired.
- [ ] Do not remove `doctor`, `similar`, or `sync-if-dirty` without a specific
      product decision: they are currently documented as intentional CLI-only
      human/operator conveniences.
- [ ] If any CLI surface changes, update all matching surfaces together:
      README, `docs/CLI-REFERENCE.md`, `docs/cli-mcp-alignment.md`,
      `src/mcp/server-instructions.ts`, command help/tests, and MCP load docs
      if the playbook size changes.

## Recommended Verification For More CLI/MCP Surface Work

Run focused checks first:

```sh
CARTOGRAPH_HOOKS_IN_PROCESS=1 CARTOGRAPH_TRACK_CONSUMED_ARGS=1 \
  bun test --timeout 60000 \
  __tests__/cli-mcp-alignment.test.ts \
  __tests__/tool-surface-smoke.test.ts \
  __tests__/readme-drift.test.ts \
  __tests__/mcp-tool-registry.test.ts
```

Then run broader gates:

```sh
npm run typecheck
npm run check
npm run check:mcp-load
npm run check:biomarkers
npm run test:fast
bun src/bin/cartograph.ts compare-to-ref --findings-delta --include-biomarkers
```

For changes intended to land on `main`, run Sonar using the local credentials
from `AGENTS.md`, then check the quality gate by `analysisId` before pushing.
