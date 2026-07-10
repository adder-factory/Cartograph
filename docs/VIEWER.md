# Viewer

`cartograph viewer` opens a local web UI on top of the same graph index used by
the CLI and MCP server. The HTTP server enforces a loopback-only bind
(`127.0.0.1` by default), self-hosts every browser asset, and makes no
third-party browser requests or telemetry calls.

“Local UI” does not mean every configured backend is local. A PostgreSQL index
can live on another host. The System overview probes configured LLM endpoints,
and Ask sends the question plus selected code context to the configured chat
endpoint. If those endpoints are cloud services, that data leaves the machine
under the configuration you chose. See [Configuration](CONFIGURATION.md) and
[Storage backends](STORAGE-BACKENDS.md).

```sh
cartograph index .        # the viewer needs an index
cartograph viewer .
# open http://127.0.0.1:8765/
```

| Flag | Effect |
|---|---|
| `-p, --port <n>` | HTTP port (default 8765; pass 0 for an OS-picked port) |
| `--no-open` | Do not auto-open the URL in a browser |
| `--session <idOrLabel>` | Scope this instance to one recorded MCP session (see Sessions) |

## Tabs

- **Graph** — interactive force-directed view of symbol neighborhoods, with a
  detail pane, source panel, and graph tools.
- **Agent trace** — a full-page timeline over recorded MCP sessions: per-call
  clock, gap-from-previous-call, duration, and result columns, a step-detail
  card with the full arguments and "On the graph" link chips (one per
  symbol, path endpoint, search name, or file the call touched — click to
  focus it on the Graph tab), replay, and JSON export. The filter box narrows the timeline by tool, args,
  or result text; replay walks only the matching steps while a filter is
  active.
- **Live** — watch MCP tool calls stream in as an agent uses cartograph on
  this project: a following feed with per-call args, duration, and result,
  plus an active-session card and a live tool-mix breakdown. The feed
  shows exactly one session at a time: the dropdown picks which, defaults
  to the newest, and follows new sessions until you choose one
  explicitly. A filter box narrows the visible calls by text, and
  clicking a symbol-bearing call focuses that symbol on the Graph tab.
- **System** — a tab with its own sub-nav (Overview / Health / Settings):
  - **Overview** — a project status page: file / symbol / edge / language
    counts, database size, indexer version, and in-sync state; a
    feature-readiness breakdown (summaries, embeddings, coverage, roles,
    directory summaries, unresolved refs); and LLM backend reachability.
    Backed by `GET /api/system`.
  - **Health** — project-wide health score gauge, findings with per-biomarker
    severity breakdowns, risk hotspots, index coverage, and symbol-kind
    breakdown.
  - **Settings** — edit `.cartograph/config.json` and re-index from the
    browser. The viewer is loopback-only; remote binding is rejected because
    the page token is a same-origin API control, not remote-user authentication.

## Browser security and local state

Each launch creates a random API token, embeds it only in the served page, and
requires it on every `/api/` request. Host and Origin checks protect the local
service from DNS rebinding and cross-origin requests. Responses also set a
self-only Content Security Policy, deny framing and MIME sniffing, suppress
referrers and browser capabilities, and mark token-bearing HTML and API data
`Cache-Control: no-store`. Versioned static assets retain ETag revalidation.

Saved views, graph snapshots, and pinned node positions can contain symbol
names and project-relative paths. They are stored in browser `localStorage`
under a one-way, per-project namespace so projects that reuse the same viewer
origin cannot read or replay one another's saved graph data. Other display
preferences remain origin-local. **Reset saved state** removes the current
project's saved graph content, viewer preferences, and URL state without
deleting another project's namespaced graph content.

## Sessions

The Agent-trace and Live tabs group recorded MCP tool calls into
sessions — one session per MCP server connection, created on its first
tool call. Pickers name each session by the best available handle: a
user label (set via `cartograph_session({action: "create", label})`),
else the connecting client's self-reported name from the MCP handshake
(for example `claude-code`), else the raw session id (always available
as the option tooltip and in the step detail). Each session also
records the project root its server was bound to.

One database = one graph viewer: every cartograph project records its
own sessions in its own index, the viewer serves only sessions
recorded against its project's root (anything stamped for a different
root is never listed or streamed; unstamped sessions from older
binaries still show), and each project launches its own viewer — the
default port falls back to a free one when 8765 is already taken, and
the browser tab carries the project name, so running one viewer per
project in separate tabs is the intended way to monitor several at
once. A
single server can still answer one-off calls about another project via
the `projectPath` tool argument; such calls stay in this project's
trace and show an explicit `project` row in the step detail.

To give each agent its own isolated window, launch one viewer per
session: `cartograph viewer --session <id-or-label> --port 0`. A scoped
instance serves nothing but that session — the session list returns
only it, other sessions' details answer 404, and the live stream is
filtered server-side. Scoping by label works even before the session
exists; the viewer waits and locks on at its first tool call. The
browser tab is titled with the project name (plus the session when
scoped), so several viewers stay tellable apart.

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
- **Saved views** — name, save, and reload project-scoped graph states; quick
  snapshots capture the current payload for replay in that project.
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
| `g g` / `g t` / `g l` / `g s` | Switch to Graph / Agent trace / Live / System tab |
| `0`, `+`, `-` | Fit all, zoom in, zoom out |
| `Esc` | Dismiss overlays and leave input fields |

## Sharing and export

Viewer state (focus, tab, filters) persists in the URL hash, so links restore
the same view; the file-scope filter is omitted while fully enabled, which
keeps links portable across projects. The canvas exports to PNG and SVG, and
the underlying graph data to JSON. A diagnostics panel reports layout and
rendering stats and can copy a full bug report; the minimap in the corner
pans the canvas.
