/**
 * CLI commands generated from each MCP tool's Zod schema — extracted from
 * the bin/cartograph.ts decomposition.
 */
import { registerGeneratedCommand, runViaMCPCapture } from '../_cli-core.js';
import { makeCompareToRefMcpRunner } from '../../features/compare-to-ref/index.js';

const runCompareToRefViaMcp = makeCompareToRefMcpRunner({
  runViaMCPCapture,
  writeStdout: (message) => process.stdout.write(message),
  writeStderr: (message) => process.stderr.write(message),
  exit: (code) => process.exit(code),
});

// ── P8: commands generated from the tool Zod schema ─────────────────
// One schema drives both the MCP `inputSchema` and the CLI option
// list, so the two surfaces cannot drift (the `cli-mcp-alignment`
// arg-shape test enforces it). Each `registerGeneratedCommand` below
// replaces a hand-written `runViaMCP` shim — see the breadcrumb
// comments left at each command's former source location.
//
// `note` renders its `action` enum as a POSITIONAL (family-command
// surface). `shortFlags` preserves the short flags the hand-written
// predecessors exposed (dropping them would be a UX regression).
// `positionalFields` renders a data field as a positional argument.
// `negatableFields` forces the `--no-<flag>` form on an optional
// boolean whose schema deliberately omits `.default(true)`.
export function registerGeneratedCommands(): void {
  registerCoreGeneratedCommands();
  registerFlatGeneratedCommands();
  registerInspectionGeneratedCommands();
  registerModuleGeneratedCommands();
  registerReviewGeneratedCommands();
  registerGraphGeneratedCommands();
}

function registerCoreGeneratedCommands(): void {
  registerGeneratedCommand('cartograph_changed_since');
  // `--action <name>` aliases the discriminator positional so the MCP
  // shape `cartograph note --action list` parses (mirrors the MCP arg
  // name without changing the canonical `cartograph note list` form).
  registerGeneratedCommand('cartograph_note', {
    discriminatorAsPositional: true,
    aliasFlags: { action: 'action' },
  });
  registerGeneratedCommand('cartograph_entry_points');
}

function registerFlatGeneratedCommands(): void {
  // Flat shims — `<task>` / `<prompt>` / `<symbol>` etc. as positionals.
  registerGeneratedCommand('cartograph_context', {
    positionalFields: ['task'],
    negatableFields: ['code'],
    shortFlags: { maxNodes: '-n', format: '-f' },
  });
  registerGeneratedCommand('cartograph_propose_rename', {
    positionalFields: ['symbol', 'newName'],
    shortFlags: { limit: '-l' },
  });
  registerGeneratedCommand('cartograph_blame', {
    positionalFields: ['symbol'],
    shortFlags: { limit: '-l' },
  });
  registerGeneratedCommand('cartograph_history', {
    positionalFields: ['symbol'],
    shortFlags: { limit: '-l' },
  });
}

function registerInspectionGeneratedCommands(): void {
  // `node` — the schema's `symbols` array IS the variadic positional;
  // the scalar `symbol` field is skipped (the variadic covers the
  // single-symbol form so it never needs a flag).
  // `--symbol <name>` is registered as a named-flag alias so the MCP
  // shape `cartograph node --symbol X` parses; the value lands in the
  // schema's own scalar `symbol` field (the MCP node tool accepts
  // either `symbol` or `symbols`), so no array wrapping is needed.
  registerGeneratedCommand('cartograph_node', {
    positionalFields: ['symbols'],
    skipFields: ['symbol'],
    aliasFlags: { symbol: 'symbol' },
  });
  // `suppressLineRangeOnly` is an optional boolean whose schema omits
  // `.default(true)` (the handler applies `!== false`), so it needs an
  // explicit negatableFields entry to render as the negating
  // `--no-suppress-line-range-only` — matching the hand-written
  // predecessor's opt-OUT surface.
  registerGeneratedCommand('cartograph_compare_to_ref', {
    shortFlags: { ref: '-r' },
    negatableFields: ['suppressLineRangeOnly'],
    runViaMcp: runCompareToRefViaMcp,
  });
  registerGeneratedCommand('cartograph_deps');
  registerGeneratedCommand('cartograph_biomarkers', { shortFlags: { limit: '-l' } });
  registerGeneratedCommand('cartograph_hotspots', { shortFlags: { limit: '-l' } });
  registerGeneratedCommand('cartograph_host');
  registerGeneratedCommand('cartograph_dead_code');
}

function registerModuleGeneratedCommands(): void {
  // `imports` — `[file]` positional + `--file <path>` alias both
  // route to the MCP `pathFilter` field (MCP `pathFilter` is a prefix;
  // passing a full file path matches exactly that file in practice).
  // Closes handoff #24: the CLI previously had no way to scope to a
  // single file at all — both `imports --file X` and `imports X`
  // errored. The positional renames `pathFilter` to `file` on the CLI
  // surface so the natural `imports src/index.ts` shape works; the
  // MCP `args` key forwarded is still `pathFilter`.
  registerGeneratedCommand('cartograph_imports', {
    shortFlags: { limit: '-l' },
    positionalFields: ['pathFilter'],
    aliasFlags: { file: 'pathFilter' },
  });
  // `explore` — the schema's plain-string `query` field renders as a
  // SPACE-JOINED variadic positional (`explore <query...>`), so a
  // multi-word query needs no shell quoting.
  // `--query` mirrors the MCP arg name; `--start` is the parallel
  // alias matching the `graph --start` shape (both commands take a
  // "starting" symbol/topic and the parallel naming reads naturally
  // from the agent side).
  registerGeneratedCommand('cartograph_explore', {
    joinedVariadicPositional: 'query',
    aliasFlags: { query: 'query', start: 'query' },
  });
  // `tests-for` — `symbol` as the `[symbol]` positional; `files` as the
  // variadic `--files`. `-d`/`-f` short flags preserved from the
  // hand-written predecessor.
  registerGeneratedCommand('cartograph_tests_for', {
    positionalFields: ['symbol'],
    shortFlags: { depth: '-d', filter: '-f' },
  });
}

function registerReviewGeneratedCommands(): void {
  // `role` — the `role` enum as the `[role]` positional; `-l` short flag
  // preserved. `--symbol` / `--symbols` / `--via` derive from the schema.
  registerGeneratedCommand('cartograph_role', {
    positionalFields: ['role'],
    shortFlags: { limit: '-l' },
  });
  // `sql` — `query` as the `[query]` positional; `-l` short flag
  // preserved. `--tables` is variadic (its schema field is a
  // preprocess-wrapped string array); the `commaSplitFields` option
  // splits each token by `,` so `--tables nodes,edges` is normalised
  // to `['nodes', 'edges']` (handoff #26 — the previous behaviour
  // treated `nodes,edges` as one literal table name and matched
  // nothing; matches the comma-handling convention used by
  // `find --fields name,id`).
  registerGeneratedCommand('cartograph_sql', {
    positionalFields: ['query'],
    shortFlags: { limit: '-l' },
    commaSplitFields: ['tables'],
  });
  // `coverage` — pilot ToolContract command. Its CLI metadata lives next
  // to `COVERAGE_TOOL` so schema, flags, help examples, and tests can
  // read one source.
  registerGeneratedCommand('cartograph_coverage');
}

function registerGraphGeneratedCommands(): void {
  // `graph` — `start` as the `[start]` positional; `symbols` (batched
  // form) has no CLI flag. `direction` defaults to `callers` CLI-side
  // (`flagDefaults`); the schema field `k` is exposed as `--top-k`
  // (`longFlagOverrides`); `compact` renders the `--no-compact` pair.
  // `--start <name>` aliases the `start` positional so the MCP shape
  // `cartograph graph --start FileWatcher` parses (mirrors the MCP arg
  // name without changing the canonical `cartograph graph FileWatcher`
  // positional form).
  registerGeneratedCommand('cartograph_graph', {
    positionalFields: ['start'],
    skipFields: ['symbols'],
    negatableFields: ['compact', 'includeTests'],
    flagDefaults: { direction: 'callers' },
    longFlagOverrides: { k: '--top-k' },
    shortFlags: { direction: '-d', limit: '-l', edgeKind: '-e', k: '-k' },
    aliasFlags: { start: 'start' },
  });
}

// `cartograph tests-for [symbol]` — P8-wave, generated from the
// cartograph_tests_for Zod schema. `symbol` renders as the `[symbol]`
// positional; `files` (a `z.array(z.string())` field) as the variadic
// `--files <paths...>`. The hand-written `-s, --symbol` flag alias is
// dropped — the positional already covers the single-symbol form. The
// `symbol`-vs-`files` mutual exclusion is enforced by the MCP handler
// and surfaced by `runViaMCP` as a clean `✗ …` error. Registered in
// the generated-command block (grep `registerGeneratedCommand`).

// `cartograph propose-rename <symbol> <newName>` — P8-wave, generated
// from the cartograph_propose_rename Zod schema. Registered in the generated-command block (grep `registerGeneratedCommand`).

// `cartograph graph <start>` — P8-wave, generated from the cartograph_graph
// Zod schema. The unified graph-navigation command (callers / callees /
// impact / BFS walk), replacing the pre-merge `callers` / `callees` /
// `impact` / `walk` family. Two generator features earn their keep here:
// `flagDefaults` supplies the CLI's `--direction` default (`callers`) —
// the schema keeps `direction` a bare required enum so an MCP caller
// stays explicit — and `longFlagOverrides` maps the schema field `k`
// onto the CLI's long-standing `--top-k`. `--fields` is variadic (its
// schema field is a string-enum array); `compact` renders the
// `--no-compact` / `--compact` tri-state pair; `symbols` (the batched
// form) has no CLI flag — the CLI takes a single `<start>` positional.
// Registered in the generated-command block (grep `registerGeneratedCommand`).

// `cartograph grep` removed — folded into `cartograph find --by content <pattern>` (2026-05-11).
