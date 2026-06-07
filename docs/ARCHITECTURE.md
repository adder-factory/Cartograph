# Cartograph Architecture Rules

Cartograph should evolve by feature slice, not by broad technical layer.
Use the platform's natural unit as the feature boundary:

- MCP tool or tool action
- CLI command or subcommand
- installer flow
- index hook
- language extractor
- LLM action

As of 2026-06-07, the broad feature-slice migration is complete. New work
should treat the current repo shape as the standard and make local
improvements inside the slice being touched instead of starting another broad
reorganization pass.

## Core Rules

- Organize by feature, not by layer.
- One feature is one self-contained, independently testable unit.
- Use the platform's natural unit as that unit. Do not invent a layer on top
  of it.
- Put an explicit contract at every boundary: types, schemas, stable result
  shapes, or stable error codes.
- Validate data where it crosses a trust line: CLI args, MCP args, config,
  file-system input, external process output, HTTP responses, and database
  rows.
- Expected failures are return values. Reserve exceptions for genuinely
  unexpected states or low-level failures that cannot be handled locally.
- Consistency beats cleverness. Repeated slices should look predictable.
- Prefer the simplest local structure that keeps behavior and contracts clear.
  Add indirection only when it removes real complexity or matches an existing
  pattern.
- Verify your own work before calling it done: type-check plus focused tests at
  minimum, broader gates for shared behavior.

## Current Ownership

These are the current owner modules future sessions should preserve:

- Graph primitives live in `src/graph/core-types.ts`.
  `src/types.ts` re-exports them only as a compatibility barrel.
- Graph traversal/context contracts live in `src/graph/types.ts` and
  `src/context/types.ts`.
- Extraction contracts live in `src/extraction/types.ts`.
- Database contracts live in `src/db/types.ts`.
- Search contracts live in `src/search/types.ts`.
- Files feature filtering, rollup, and render runtime helpers live in
  `src/features/files/runtime.ts`; MCP and CLI adapters consume that feature
  runtime.
- CLI command-shape contracts live in `src/features/shared/cli-command.ts`.
- Generated CLI command bootstrap is explicit via `src/bin/commands/index.ts`.
  Command modules should export registration functions and should not register
  commands just because they were imported.
- Biomarker floor enforcement lives in `scripts/check-biomarkers.mjs`; keep the
  bar at 0 error / 0 warning / 0 info unless the user explicitly changes the
  project standard.

Avoid adding new "misc" or "shared" buckets unless the contract is genuinely
cross-feature and already has multiple consumers. Prefer putting helpers next
to the feature that owns the behavior.

## Slice Shape

Prefer this shape for new features and touched large features:

```text
src/features/<feature>/
  contract.ts   # schemas, input/output types, stable error codes
  runtime.ts    # feature logic; returns typed outcomes for expected failures
  format.ts     # markdown/json/human renderers, when non-trivial
  cli.ts        # commander adapter only
  mcp.ts        # MCP adapter, when applicable
  index.ts      # public exports for the slice
```

Do not force every small slice to have every file. A tiny feature can keep its
contract in `runtime.ts` or `cli.ts` if that is clearer. Split when a boundary
becomes real: schema validation, runtime logic, formatting, adapter behavior,
or tests.

For MCP tools, prefer this dependency direction:

```text
src/features/<feature>/runtime.ts
src/features/<feature>/render.ts
src/mcp/tools/<feature>.ts      # adapter: schema, validation, ToolOutcome
src/features/<feature>/cli.ts   # adapter: commander args, stdout/stderr
```

MCP adapters should not own feature behavior that CLI or other callers also
need. Put shared feature behavior under `src/features/<feature>/` and import it
from the adapters.

For MCP-only tools that still live as single files under `src/mcp/tools`, keep
schemas and handlers explicit, and extract feature-owned runtime modules when
the tool grows or another surface needs the behavior.

## Failure Boundaries

Expected operator and user failures should be return values:

```ts
type FeatureResult<T> =
  | { ok: true; value: T; warnings?: FeatureWarning[] }
  | {
      ok: false;
      error: { code: string; message: string; remediation?: string };
      exitCode: 1 | 2;
    };
```

Adapters decide how to render the result and whether to set `process.exitCode`.
Runtime code should not call `process.exit()` for expected failures.

Reserve exceptions for unexpected states, programmer errors, and low-level
I/O failures that cannot be handled meaningfully at the feature boundary.

## Adapter Rules

CLI and MCP adapters should be thin:

- Parse and validate inputs.
- Call feature runtime functions.
- Render typed outcomes.
- Set `process.exitCode` or return `ToolOutcome` at the edge.

Adapters should not:

- Own reusable feature algorithms.
- Reach into another adapter for helpers.
- Call `process.exit()` for expected user/operator failures.
- Hide schema drift between CLI and MCP surfaces.

If CLI and MCP both need the same behavior, move the behavior to
`src/features/<feature>/runtime.ts` or a feature-local helper and import it from
both adapters.

## Migration Order

The broad migration is done. Keep this historical order as guidance for future
cleanup, but prefer local improvements while touching a feature. Avoid broad
folder moves that do not improve contract clarity.

1. Backend and LLM operator features
   - Keep lifecycle commands, runtime state, logs, smoke checks, and doctor
     diagnostics feature-local.
   - Maintain JSON output contracts for automation.

2. CLI/admin actions
   - Split large command files by natural command/action.
   - Move parsing/formatting to adapters; keep runtime logic typed.
   - Replace helper-level `process.exit()` with typed expected failures.

3. MCP tools
   - Use `defineToolContract` for schema, handler args, CLI metadata, and
     read/write metadata.
   - Split large family tools by mode/action while keeping public tool names
     stable.
   - Keep flat MCP schemas when compatibility requires them, but validate
     action-specific requirements in typed branch validators.

4. Index hooks
   - Preserve hook ordering.
   - Extend hook outcomes so `skipped`, `partial`, and `failed` are explicit.
   - Convert hooks with broad internal catches first.

5. LLM service internals
   - Introduce prepared-action boundaries: resolve config, check reachability,
     create client, return typed outcome.
   - Keep compatibility wrappers until CLI/MCP call sites migrate.

6. Extraction
   - Strengthen extractor contracts before moving files.
   - Ensure extractors return `ExtractionResult` for expected parse failures.
   - Move custom extractors closer to language definitions only after contract
     tests are in place.

## Verification

Every feature-slice change should run:

- `bun run typecheck`
- `bun run check`
- focused tests for the touched feature

Run broader checks when public contracts or shared behavior change:

- `bun run check:biomarkers`
- `bun run test:coverage`
- `bun run check:mcp-load`
- relevant smoke scripts under `package.json`

Before finishing edit-touching work, also run:

- `bun src/bin/cartograph.ts compare-to-ref --findings-delta --include-biomarkers`

For changes intended to land on `main`, run Sonar with the local credentials
documented in `AGENTS.md` and verify the quality gate through the API, not just
scanner success. The expected healthy state is:

- Sonar quality gate OK
- open issues: 0
- hotspots to review: 0
- biomarkers: 0 / 0 / 0

## New Session Handoff

Future sessions should read this file and `AGENTS.md` before architecture or
feature work. The short instruction to give a new agent is:

```text
Follow AGENTS.md and docs/ARCHITECTURE.md. The feature-slice architecture
migration is complete; use the current repo shape as the standard for new
work.
```
