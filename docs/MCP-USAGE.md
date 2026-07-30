# MCP usage for coding agents

Last release audit: 2026-07-30 (`v2.1.0`).

Cartograph v2 exposes a compact native stdio MCP server. Its core returns
bounded, generation-scoped evidence and never makes the database a source of
truth over the live checkout. The optional `cartograph_ask`, role, summary, and
dead-code-judge branches can call configured LLM tiers; their model/evidence
provenance, failure, and fallback states remain explicit.

## Registration

Prefer the native installer because it writes project-local configuration and
pins the absolute executable path:

```sh
cartograph install --yes --target codex --location local --project-path .
cartograph install --yes --target claude --location local --project-path .
cartograph install --yes --target cursor --location local --project-path .
```

When the managed database uses a non-default loopback port, add
`--managed-database-port <PORT>` to the install command. The generated stdio
command carries that port directly; no host-specific environment table is
required.

Manual server definition:

```json
{
  "command": "/absolute/path/to/cartograph",
  "args": [
    "serve",
    "--mcp",
    "--project-path",
    "/absolute/path/to/project",
    "--managed-database-port",
    "55435"
  ]
}
```

Omit the final two arguments when the project uses the default port `55432` or
external PostgreSQL through `CARTOGRAPH_DATABASE_URL`.

Restart the host after installation. An already-open host is not assumed to
hot-reload an upgraded MCP process.

## Profiles

- `coding`: lean retrieval, source, graph, test-selection, and review loop;
- `core`: normal coding tools plus explicit bounded administration;
- `full`: every advertised tool, including bounded administration;
- `read-only`: retrieval without write/admin operations;
- `review`: comparison and verification-oriented surface.

Tool lists are deterministic, and a tool hidden by the selected profile cannot
be called by name. Use the narrowest profile that supports the workflow.

## Selected high-use tools

The full profile advertises 35 tools. The table below highlights the normal
coding loop; see the [complete CLI/MCP alignment inventory](cli-mcp-alignment.md#public-mcp-tools)
for all 35 wire contracts and their CLI families.

| Tool | Purpose |
| --- | --- |
| `cartograph_status` | Current generation, row counts, and complete supported-source freshness |
| `cartograph_context` | Intent-aware exact/BM25/hybrid packet, typed primary edit candidates, graph evidence, affected tests, trust, and live overlay |
| `cartograph_find` | Exact name/path/reference or BM25/hybrid candidates |
| `cartograph_files` | Bounded current-generation file inventory filtered by directory or language |
| `cartograph_entry_points` | Typed routes, CLI commands, MCP tools, CLI declarations, and public API boundaries with exact totals |
| `cartograph_at_range` | Exact symbols overlapping one source range or diff hunk |
| `cartograph_node` | Exact symbol metadata and bounded source only when indexed line provenance is fresh |
| `cartograph_graph` | Bounded callers/callees/impact, exact edge filters, shortest paths, or model-scoped pgvector symbol neighbors |
| `cartograph_affected` | Structurally connected test candidates |
| `cartograph_review` | Git-ref plus committed/staged/unstaged/untracked review packet |
| `cartograph_playbook` | Complete agent workflow, tool-routing map, evidence discipline, and anti-patterns |
| `cartograph_admin` | Start, inspect, or cancel bounded lifecycle, index, semantic, model, and SCIP interchange work |

`cartograph_context` classifies deterministic task intents such as symbol
lookup, implementation trace, change planning, test selection, error diagnosis,
architecture survey, and documentation lookup. Intent selects bounded candidate,
graph, evidence, and affected-test policy and is returned in the packet.

When the durable generation is stale, supported changed/untracked files may
contribute a separate live working-tree overlay. Overlay items include path,
Git change kind, exact content digest, line-bounded excerpt, matched terms, and
truncation. They are never relabeled as durable graph evidence.

## Reliable agent loop

1. `cartograph_status`.
2. `cartograph_context` with the concrete coding task and any known exact
   name/path/reference anchors.
3. Orient with `entry_points`, then focus with `files`, `at_range`, `find`,
   `node`, or `graph`; use
   `direction: path` with `toSymbolId` when the question is how two exact
   symbols connect; use `direction: similar` for stored-vector peers and keep
   the returned model ID and score provenance, then read the exact files before
   editing.
4. Make the change.
5. `cartograph_review` against the intended base and `cartograph_affected` for
   verification candidates.
6. Run the project's actual formatter, linter, type, test, and security gates.
7. Re-index only when current graph evidence is needed after source changes.

The initialize handshake contains the compact version of this loop. Call
`cartograph_playbook` for the complete on-demand guide, or run
`cartograph guide` outside MCP.

Always preserve generation ID, freshness, confidence, abstention, component
ranks, coarse reference precision, multiplicity, truncation, and overlay status
in downstream reasoning. A candidate is evidence to inspect, not proof that a
change is correct.

## Transport contract

The server uses newline-delimited JSON-RPC over stdio and writes no diagnostic
text to stdout. It enforces:

- bounded input and serialized output bytes;
- bounded concurrent requests;
- a hard wall-clock request deadline;
- cancellation with worker abort/reaping;
- stable public error codes and redacted internal failures;
- deterministic tool/schema ordering.

Do not retry by removing bounds or wrapping the server with an unbounded queue.
For long index work, use `cartograph_admin` to start a job and poll status; cancel
explicitly when the host/user abandons it.

SCIP interchange is also job-based. Use `action: "scip-export"` with a
project-relative `out`, or `action: "scip-import"` with a project-relative
`in`. Import persists a digest-fenced overlay, forces indexing, preserves files
the SCIP artifact does not cover, and reports exact typed-edge versus unresolved
foreign-link counts. The browser visualizer is intentionally absent; graph and
interchange data remain available to agents.

If the MCP transport closes, report that limitation and use the equivalent
native CLI as a control path. CLI success alone does not prove the host's MCP
registration or running process was refreshed.
