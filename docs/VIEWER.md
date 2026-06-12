# Viewer

`cartograph viewer` opens a local-only web UI on top of the same graph index
used by the CLI and MCP server. Nothing leaves your machine: the server binds
to localhost and reads the existing `.cartograph` index.

```sh
cartograph index .        # the viewer needs an index
cartograph viewer .
# open http://localhost:8765/
```

| Flag | Effect |
|---|---|
| `-p, --port <n>` | HTTP port (default 8765; pass 0 for an OS-picked port) |
| `--no-open` | Do not auto-open the URL in a browser |

## Tabs

- **Graph** — interactive force-directed view of symbol neighborhoods, with a
  detail pane, source panel, and graph tools.
- **Agent trace** — a full-page timeline over recorded MCP sessions: per-call
  clock, gap-from-previous-call, duration, and result columns, a step-detail
  card with the full arguments, replay, JSON export, and a per-step
  "View on graph" jump. The filter box narrows the timeline by tool, args,
  or result text; replay walks only the matching steps while a filter is
  active.
- **Live** — watch MCP tool calls stream in as an agent uses cartograph on
  this project: a following feed with per-call args, duration, and result,
  plus an active-session card and a live tool-mix breakdown. A filter box
  narrows the feed by text, a session dropdown limits it to one session,
  and clicking a symbol-bearing call focuses that symbol on the Graph tab.
- **Health** — project-wide health score gauge, findings with per-biomarker
  severity breakdowns, risk hotspots, index coverage, and symbol-kind
  breakdown.

## Reading the graph

Node shapes encode the kind of symbol:

| Shape | Kinds | Meaning |
|---|---|---|
| Circle | function, method, and any kind without a dedicated shape | Callables |
| Rounded square | class, struct, enum | Type containers |
| Diamond | interface, trait, type alias, protocol | Contracts |
| Rectangle | file, module, namespace | Containers |
| Barrel | table, resource | Data stores |
| Hexagon | route, component | Entry points |
| Tag | import, export | Module wiring |

On top of the shapes:

- **Hub halos** — highly connected symbols get a faint kind-colored halo that
  scales with graph centrality, so hubs stand out before you read a single
  label.
- **Health borders** — node borders encode the worst finding on the symbol:
  thick red for error, orange for warning, blue for info, a thin dark border
  for healthy.
- **Edge styles** — each edge kind has its own color and line style (for
  example `calls` solid blue, `imports` dashed green, `field_access` dotted
  yellow). The edge-kind filter in the left rail is populated from the kinds
  present in the current graph; `similar_to` and `def_use` are never drawn.

## Filters

All filters live in the left rail and start fully enabled:

- **Kind chips** — eight grouped toggles (functions, methods, classes/structs/
  enums, interfaces/types/traits/protocols, variables/constants, files/modules,
  imports/exports, routes/components/tables/resources).
- **Health** — show or hide error / warning / info / healthy symbols.
- **File scope** — top-level directories of the indexed project, derived from
  the index per project (top directories by symbol count plus an "everything
  else" row). Unchecking a row hides that part of the tree.
- **Edge kinds** — per-kind checkboxes with All/None shortcuts, plus an edge
  lens that restricts drawn edges to those touching the current focus.

## Graph tools

- **Impact** — incoming/outgoing dependency walk from the focused symbol
  (callers, callees, or both).
- **Path** — shortest path between two symbols, with edge-kind filtering.
- **Compare** — highlights symbols in files changed against `HEAD`.
- **Saved views** — name, save, and reload graph states; quick snapshots
  capture the current payload for replay.
- **Density and layout** — Focus / Core / All density modes, Fast / Balanced /
  Spread layout quality, collapsible directory groups, and grouped or expanded
  rendering of low-level detail nodes (variables, fields, parameters).
- **Pinning** — pin node positions, unlock them, or reset pins and rerun the
  layout.

## Symbol detail

Selecting a node fills the detail pane: health, centrality, coverage, lines of
code, cyclomatic complexity, nesting depth, parameter count, and recent
commits, with subtabs for callers, callees, per-biomarker findings, and
per-symbol line/branch coverage. The source panel below the canvas shows
syntax-highlighted code with in-file search and go-to-line (ranges like
`10-50` work). From the detail row you can open the symbol in an editor
(VS Code, Cursor, Windsurf), copy a shareable viewer link, or copy a
ready-to-paste MCP tool snippet for the symbol.

When an LLM is configured (see [CONFIGURATION.md](CONFIGURATION.md)), the Ask
panel answers questions about the selected symbol, a highlighted code
selection, or an inspected edge.

## Keyboard

| Keys | Action |
|---|---|
| `/` | Focus search (the local filter on the Live / Agent trace tabs) |
| `Cmd/Ctrl+K` | Command palette |
| `Alt+←` / `Alt+→` | Navigation history |
| `g g` / `g t` / `g l` / `g h` | Switch to Graph / Agent trace / Live / Health tab |
| `0`, `+`, `-` | Fit all, zoom in, zoom out |
| `Esc` | Dismiss overlays and leave input fields |

## Sharing and export

Viewer state (focus, tab, filters) persists in the URL hash, so links restore
the same view; the file-scope filter is omitted while fully enabled, which
keeps links portable across projects. The canvas exports to PNG and SVG, and
the underlying graph data to JSON. A diagnostics panel reports layout and
rendering stats and can copy a full bug report; the minimap in the corner
pans the canvas.
