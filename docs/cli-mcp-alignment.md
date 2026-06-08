# CLI / MCP alignment

Cartograph exposes the same code-intelligence surface through two
transports: the **MCP server** (`cartograph serve --mcp`) for agents,
and the **CLI** (`cartograph <command>`) for humans. The two surfaces
are kept in lockstep — every MCP tool has a CLI mirror, every CLI
command has a corresponding MCP tool, with a small set of explicit
exceptions documented below.

This document is the source of truth for that mapping. Last
re-verified **2026-06-08**. The mapping is also test-enforced —
`__tests__/cli-mcp-alignment.test.ts` fails if a tool gains/loses a
CLI mirror.
Branch-specific argument consumption is test-enforced in
`__tests__/tool-surface-smoke.test.ts` with strict consumed-arg
tracking; add a matrix case there when a tool gains a new mode/action
branch whose arguments are not covered by the generic smoke call.

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
CLI commands: src/bin/commands/*.ts + src/features/*/cli.ts → src/bin/cartograph.ts
```

100% of alignable capabilities are mirrored on both surfaces.

### Aligned capabilities

Every MCP `cartograph_X` has a matching CLI `cartograph X` (or a
family subcommand under `admin <action>` / `summaries <action>` /
`review <subcommand>`):

```
admin (init / uninit / index / sync / unlock / migrate / storage-migrate /
       build-similarity-edges / embed-only / prune-store /
       summarize / embed / classify / scip-export / scip-import /
       install-models / doctor / llm-plan / llm-apply / llm-tune)
affected, ask, at-range, biomarkers, blame, changed-since,
compare-to-ref, context, coverage, dead-code, deps, digest,
discover, entry-points, explore, files, find, graph, history,
hotspots, imports, local-chat, node, note, playbook,
propose-rename, review (context / neighbors / risk / agent-audit / trust),
role, session (create / resume / list / delete / macro_save /
macro_run / macro_list / macro_delete), sql, status,
summaries (pending / save),
sync-if-dirty, tests-for, trace-to-culprits
```

`cartograph file-deps`, `cartograph file-symbols`, and `cartograph module`
survive as CLI shortcuts for human ergonomics. MCP callers use the folded
`cartograph_files` modes instead:
`{format: "deps" | "symbols" | "module"}`.

`cartograph similar <symbol>` is an extra CLI-only shortcut — it has no
standalone MCP tool; it routes through `cartograph_graph({direction:
'similar'})`.

`cartograph sync-if-dirty` is also CLI-only. It exists for hook compatibility
and delegates to the same sync runtime shape only when git reports source
changes.

`cartograph dead-code` and `cartograph coverage` take a `--via` classifier
axis — `rule` / `llm` / `auto` (default). `dead-code` also accepts the
deprecated `--mode static|judge` alias.

### CLI-only by design

- **`cartograph doctor`** — human-discoverability shortcut. The MCP
  mirror is `cartograph_admin({action: 'doctor'})`, and the nested CLI
  form `cartograph admin doctor` exists for admin-family parity.
- **`cartograph serve`** — IS the MCP server; can't run via MCP
  itself.
- **`cartograph install`** — agent MCP installer; writes supported local or
  global MCP client configuration. Interactive prompts.
- **`cartograph install-hooks`** — git hook installer; touches `.git/hooks/`
  and is intentionally CLI-only repository maintenance.
- **`cartograph mcp-budget`** — measures the MCP connection payload
  before a session starts (`tools/list` + initialize instructions).
  Exposing it through MCP would measure the surface only after the
  context cost was already paid.
- **`cartograph llm setup`** — interactive provider config wizard.
  Configures OpenAI-compatible local/cloud providers and prompts on
  conflicts.
- **`cartograph llm smoke`** — sends real tiny requests to configured
  LLM tiers. It is CLI-only because it is an operator health check for
  local/cloud credentials and backend processes, not a graph query.
- **`cartograph viewer`** — web UI; HTTP server on a port. Out of
  MCP scope.
- **`cartograph backend`** — managed local `llama-server` process
  lifecycle (`status` / `start` / `stop` / `logs`). MCP-side doctor and
  status report backend readiness, but process spawning/log tailing
  remains a human/operator CLI concern.
- **`cartograph file-deps`, `cartograph file-symbols`, `cartograph module`**
  — ergonomic CLI shortcuts. MCP-side they are folded into
  `cartograph_files({format: 'deps'|'symbols'|'module'})` to keep the
  advertised tool count at 35.

### Family-action pattern (CLI subcommands)

Family-action is the convention for tools whose surface naturally
splits into discrete actions. Adding a new subcommand goes under
the existing parent — **don't add a top-level shortcut**.

```
admin     <init|uninit|index|sync|unlock|migrate|storage-migrate|build-similarity-edges|embed-only|prune-store|summarize|embed|classify|scip-export|scip-import|install-models|doctor|llm-plan|llm-apply|llm-tune>
summaries <pending|save>
review    <context|neighbors|risk|agent-audit|trust>
note      <add|list|delete>
session   <create|resume|list|delete|macro_save|macro_run|macro_list|macro_delete>
llm       <setup|smoke>
backend   <status|start|stop|logs>
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
NO_COLOR=1 bun src/bin/cartograph.ts --help
```

### Cross-reference

Each MCP tool name (sans `cartograph_`) should match one CLI command,
modulo underscore vs dash (`cartograph_at_range` ↔ `cartograph
at-range`). Family subcommands appear at multiple lines because
Commander mounts each under its parent — that's expected; check
`src/bin/commands/*.ts`, the relevant `src/features/*/cli.ts`, and the
parent-command wiring in `src/bin/_cli-core.ts` before flagging an apparent
mismatch.

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

## How to extend an existing tool family

When adding a mode or option to a compressed tool instead of adding a
new public tool name:

1. **Schema/help**: update the tool's Zod schema description. Generated
   CLI commands mirror new schema fields automatically; hand-written
   commands must add the matching `.option(...)` and output behavior.
2. **Playbook/startup guide**: update `src/mcp/server-instructions.ts`
   so both `SERVER_INSTRUCTIONS` and `FULL_PLAYBOOK` mention the new
   route when it changes agent workflow.
3. **Installer instructions + docs**: update
   `src/installer/instructions-template.ts`, `README.md`, and focused
   docs such as `docs/STORAGE-BACKENDS.md` when the feature changes
   first-use guidance, storage/admin setup, or human CLI usage.
4. **Help parity**: for family commands such as `session`, update the
   parent-command description in `src/bin/_cli-core.ts` and add any
   new subcommand in `src/bin/commands/<family>.ts`.
5. **Load budget**: run `cartograph mcp-budget` or
   `bun run check:mcp-load`; extra schema text counts against the MCP
   startup payload even when no new tool name was added.

Recent example: `cartograph_context({task: "<task>", format: "plan"})`,
`cartograph_files({format: "deps"|"symbols"|"module"})`,
`cartograph_affected({includeCommands: true})`,
`cartograph_node({liveSource: true})`, and
`cartograph_session({action: "audit"})` were added as family
extensions to avoid expanding the top-level MCP tool count.

### Release audit guardrails

Before a release or quarterly tool-surface audit, run:

```sh
bun run check:release
```

That bundles typecheck, the architecture drift gate, Biome, the MCP
load-budget target, biomarker checks, required viewer smoke, and the
fast test suite. The smaller MCP release target intentionally fails
before the hard startup-size ceiling so schema/help growth is caught
while there is still room to trim.

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

For branch-specific fields, the consumed-args matrix is the second
line of defense. It runs representative read-safe calls under
`CARTOGRAPH_STRICT_UNREAD_ARGS=1`, so a handler that accepts an
argument on a branch but never reads it fails the test instead of
shipping a silent no-op.

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
