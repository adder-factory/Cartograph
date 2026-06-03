# CLI / MCP alignment

Cartograph exposes the same code-intelligence surface through two
transports: the **MCP server** (`cartograph serve --mcp`) for agents,
and the **CLI** (`cartograph <command>`) for humans. The two surfaces
are kept in lockstep — every MCP tool has a CLI mirror, every CLI
command has a corresponding MCP tool, with a small set of explicit
exceptions documented below.

This document is the source of truth for that mapping. Last
re-verified **2026-05-15**. The mapping is also test-enforced —
`__tests__/cli-mcp-alignment.test.ts` fails if a tool gains/loses a
CLI mirror.

The graph-navigation and find surfaces are mode-discriminated: the
pre-2026-05-11 `callers` / `callees` / `impact` / `walk` tools are
now one `cartograph_graph({direction, hops})`, and `search` / `grep` /
`string_refs` are one `cartograph_find({by, mode})` — see Family
migrations below. `cartograph similar <symbol>` survives as an
ergonomic CLI shortcut that routes through
`cartograph_graph({direction: 'similar'})`. Batched `symbols: [...]`
forms (on `graph` callers/callees, `node`, `biomarkers`, `role`) are
MCP-only by design — the CLI keeps the single-symbol form for human
ergonomics.

## State

```
MCP tools:    src/mcp/tools/*.ts → src/mcp/tools/registry.ts
CLI commands: src/bin/cartograph.ts → program / adminCmd / summariesCmd / reviewCmd
```

100% of alignable capabilities are mirrored on both surfaces.

### Aligned capabilities

Every MCP `cartograph_X` has a matching CLI `cartograph X` (or a
family subcommand under `admin <action>` / `summaries <action>` /
`review <subcommand>`):

```
admin (init / uninit / index / sync / unlock / migrate /
       build-similarity-edges / embed-only / prune-store /
       summarize / embed / classify / install-models)
affected, ask, at-range, biomarkers, blame, changed-since,
compare-to-ref, context, coverage, dead-code, deps, digest,
discover, entry-points, explore, files, find, graph, history,
hotspots, imports, local-chat, module, node, note, playbook,
propose-rename, review (context / neighbors / risk),
role, sql, status, summaries (pending / save),
tests-for, trace-to-culprits
```

`cartograph similar <symbol>` is an extra CLI-only shortcut — it has no
standalone MCP tool; it routes through `cartograph_graph({direction:
'similar'})`.

`cartograph dead-code` and `cartograph coverage` take a `--via` classifier
axis — `rule` / `llm` / `auto` (default). `dead-code` also accepts the
deprecated `--mode static|judge` alias.

### MCP-only by design

- **`cartograph_session`** — agent session state and saved tool
  macros across MCP calls. CLI invocations are one-shot processes;
  sessions span multiple MCP calls within one server lifecycle, so
  this isn't meaningful at the CLI.

### CLI-only by design

- **`cartograph serve`** — IS the MCP server; can't run via MCP
  itself.
- **`cartograph install`** — git-hooks installer; touches
  `.git/hooks/`. Interactive prompts.
- **`cartograph llm setup`** — interactive provider config wizard.
  Configures nllc GGUF models or Claude (claude-bridge / anthropic-api)
  and prompts on conflicts.
- **`cartograph viewer`** — web UI; HTTP server on a port. Out of
  MCP scope.

### Family-action pattern (CLI subcommands)

Family-action is the convention for tools whose surface naturally
splits into discrete actions. Adding a new subcommand goes under
the existing parent — **don't add a top-level shortcut**.

```
admin     <init|uninit|index|sync|unlock|migrate|build-similarity-edges|embed-only|prune-store|summarize|embed|classify|install-models>
summaries <pending|save>
review    <context|neighbors|risk>
note      <add|list|delete>
llm       <setup>
```

## Verification recipes

Run these from the repo root after any tool surface change.

### List MCP tools

```bash
grep -E "^\s*name:\s*'cartograph_" src/mcp/tools/*.ts \
  | grep -v "registry\|types\|tool-types\|shared\|symbol-resolver\|result-formatters\|_id-cache\|_call-id-cache\|_project-cache\|_schema-validate\|review-context\|review-neighbors\|risk-review\|env-refs\|sql-refs\|_search-fuzzy\|_search-semantic\|_search-intent\|_summaries-pending\|_summaries-save\|_coverage-load\|explore-budget" \
  | sed -E "s/.*name: '([^']+)'.*/\1/" | sort -u
```

### List CLI commands

```bash
grep -E "^\s*\.command\('" src/bin/cartograph.ts \
  | sed -E "s/.*command\('([a-z-]+)( |').*/\1/" | sort -u
```

### Cross-reference

Each MCP tool name (sans `cartograph_`) should match one CLI command,
modulo underscore vs dash (`cartograph_at_range` ↔ `cartograph
at-range`). Family subcommands appear at multiple lines because
Commander mounts each under its parent — that's expected; check
the parent-command mounting (`adminCmd` / `summariesCmd` /
`reviewCmd`) before flagging an apparent mismatch.

### Playbook coverage

Every public tool should appear in the full playbook exported from
`src/mcp/server-instructions.ts` (returned by `cartograph_playbook`;
the MCP `initialize` payload is intentionally compact):

```bash
for tool in $(grep -E "^\s*name:\s*'cartograph_" src/mcp/tools/*.ts \
  | grep -v "review-context\|review-neighbors\|risk-review\|env-refs\|sql-refs\|_search-\|_summaries-\|_coverage-load" \
  | sed -E "s/.*name: 'cartograph_([^']+)'.*/\1/" | sort -u); do
  count=$(grep -c "cartograph_$tool" src/mcp/server-instructions.ts || true)
  if [ "$count" -lt 1 ]; then echo "MISSING: $tool"; fi
done
```

## How to add a new tool

When adding a new MCP tool:

1. **MCP side**: new file in `src/mcp/tools/<name>.ts` exporting
   `<NAME>_TOOL`; one import + array entry in
   `src/mcp/tools/registry.ts`; one entry in
   `__tests__/mcp-tool-registry.test.ts` (alphabetical).
2. **CLI side**: prefer `registerGeneratedCommand(...)` in
   `src/bin/commands/generated.ts` — the commander definition is
   derived from the tool's Zod schema via
   `src/mcp/tools/_zod-to-cli.ts`, so a new schema field
   auto-mirrors as a CLI flag. Hand-written
   `program.command(...).option(...)` is reserved for commands with
   streaming progress / interactive UI / hand-curated subcommand
   trees (admin / files / review / session / status / summaries) —
   each carries a per-property exemption in
   `ARG_SHAPE_EXCEPTIONS` (see "Per-property exemption shape" below).
3. **Playbook**: add a bullet under the matching "When to use which
   tool" line in `src/mcp/server-instructions.ts`.

Run the verification recipes above to confirm no drift.

### Per-property exemption shape (#31 closed 2026-05-22)

`__tests__/cli-mcp-alignment.test.ts` walks every MCP tool's
`inputSchema.properties` and asserts the CLI command has a matching
flag or positional. The test uses a `ARG_SHAPE_EXCEPTIONS` map for
intentional asymmetries. Two forms:

- `tool: new Set([...])` — per-property exemption. Each named field
  is documented with an inline justification (e.g. "`action` is the
  subcommand axis, not a flag"). **Adding a new schema field to an
  exempted tool WILL fail the test** unless explicitly added to the
  Set. This is the structural guard against silent CLI drift.
- `tool: '*'` — whole-tool exemption. Bypasses the per-property
  check entirely. The #31 fix retired every pre-existing `'*'`; new
  `'*'` entries are forbidden — use a per-property Set.

Two cross-cutting properties are never required:

- `allowStale` — registry-injected on every tool by `withAllowStale`;
  the CLI deliberately does not surface it.
- (none other today, but the `GLOBALLY_IGNORED_PROPS` Set in the test
  is where future cross-cutting exemptions go.)

A new test (`'ARG_SHAPE_EXCEPTIONS per-property carve-outs name only
fields the schema still exposes'`) catches stale exemptions — a
renamed schema field with the old name still in the exception list
fails loudly instead of silently masking a NEW gap on a same-name
field elsewhere.

## Renames

When renaming a tool, do it cleanly across all surfaces in one
commit — no backward-compatibility shims or aliases. Past renames:

- **2026-05-10** `cartograph_refs` → `cartograph_string_refs`
  (`c388d08`). The original name read as a generic "find
  references" surface; actual scope is string-literal
  cross-references in non-AST domains (env-var reads, SQL-table
  refs). CLI mirror also renamed: `cartograph refs` → `cartograph
  string-refs`.

## Family migrations

When the MCP surface collapses N tools into one mode-discriminated
tool, the CLI must follow with the parallel family pattern:

- **2026-05-10** Review CLI family unified (`35ab6ce`). The MCP
  collapse of `cartograph_review_context` / `_neighbors` /
  `risk_review` into one `cartograph_review({mode})` tool happened
  earlier; the CLI followed by adding `cartograph review
  <subcommand>` matching `admin <action>`. Top-level
  `review-context` / `review-neighbors` / `risk-review` deleted.
  Later parity pass (`bfb34cb`) added the missing `agent-audit`
  subcommand, `context --diff`, and the `risk --limit` alias. The
  trust-readiness pass (`7d2a58b`) added `cartograph review trust`
  alongside `cartograph_review({mode: 'trust'})`, keeping every
  `cartograph_review` mode and exposed argument mirrored on the CLI.

- **2026-05-11** Graph + find mega-merge. `cartograph_callers` /
  `_callees` / `_impact` / `_walk` collapsed into
  `cartograph_graph({direction, hops})`; `cartograph_search` /
  `_grep` / `_string_refs` collapsed into
  `cartograph_find({by, mode})`. The CLI followed with top-level
  `cartograph graph` and `cartograph find`; the eight pre-merge
  commands were deleted (no aliases). `summarize` / `embed` /
  `classify` also folded from standalone tools into
  `cartograph_admin({action})` (CLI: `cartograph admin <action>`).

- **2026-05-14** `cartograph_similar` retired — folded into
  `cartograph_graph({direction: 'similar'})`. The `cartograph similar`
  CLI command was kept as an ergonomic shortcut routing through
  `cartograph graph` (the one case where a CLI command has no
  same-named MCP tool).
