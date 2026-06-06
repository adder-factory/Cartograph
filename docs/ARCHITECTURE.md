# Cartograph Architecture Rules

Cartograph should evolve by feature slice, not by broad technical layer.
Use the platform's natural unit as the feature boundary:

- MCP tool or tool action
- CLI command or subcommand
- installer flow
- index hook
- language extractor
- LLM action

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

For MCP-only tools that already live under `src/mcp/tools`, use the same
shape under `src/mcp/tools/<tool>/` and keep shared MCP dispatch policy in
`src/mcp/dispatch/*`.

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

## Migration Order

Apply the rules incrementally. Avoid broad folder moves that do not improve
contract clarity.

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

- `bun run test`
- `bun run check:mcp-load`
- `bun run check:biomarkers`
- relevant smoke scripts under `package.json`
