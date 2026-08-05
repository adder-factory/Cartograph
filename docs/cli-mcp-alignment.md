# CLI and MCP alignment

Last release audit: 2026-08-04 (`v2.2.0`).

Cartograph exposes one native Rust feature surface through human CLI commands
and 36 bounded MCP tools. Shared schemas generate ordinary CLI adapters where
possible; hand-curated family commands retain deliberate positional and
subcommand shapes.

The v1.1.33 public contracts are frozen in:

- `crates/cartograph-cli/src/v1_1_33_mcp_contract.json`;
- `crates/cartograph-cli/src/v1_1_33_cli_contract.json`.

Permanent Rust tests verify every v1 MCP tool/property/required field/type/
enum/bound and every v1 CLI command/alias/option/positional. The only product
capability exemption is the browser visual-graph viewer. The only storage-
contract exemptions are the intentionally removed SQLite provider and
pgvector-off mode; PostgreSQL graph functionality remains.

## Public MCP tools

<!-- CARTOGRAPH_MCP_TOOLS_START -->

```text
admin              affected            ask
at_range           biomarkers          blame
changed_since      compare_to_ref       context
coverage           dead_code            deps
digest             entry_points         explore
files              find                 graph
history            host                 hotspots
imports            node                 note
numerical          playbook             propose_rename
review             role                 session
sql                status               summaries
tests_for          trace_to_culprits    verify
```

<!-- CARTOGRAPH_MCP_TOOLS_END -->

Each appears on the wire with the `cartograph_` prefix. Profiles (`coding`,
`core`, `full`, `read-only`, and `review`) deliberately expose subsets; a
hidden tool cannot be called by name.

## Family mappings

Mode/subcommand families preserve one coherent tool instead of multiplying MCP
startup schemas:

| MCP family | CLI family examples |
| --- | --- |
| `cartograph_admin` | `admin init/index/sync/summarize/embed/classify/scip-export/scip-import/...` |
| `cartograph_find` | `find --by name/path/reference/bm25/hybrid` plus source/env/SQL/build-context modes |
| `cartograph_graph` | `graph --direction callers/callees/both/impact/path/similar` |
| `cartograph_files` | `files --format tree/flat/grouped/summary/deps/symbols/module/read` |
| `cartograph_numerical` | `numerical sites/coverage/explain/plan` |
| `cartograph_review` | `review context/neighbors/risk/agent-audit/numerical/trust` |
| `cartograph_session` | investigation, audit/usage, and macro subcommands |
| `cartograph_summaries` | `summaries pending/save` |

The native CLI retains all v1 family actions and adds v2 PostgreSQL generation,
retention, embedding-readiness, SCIP, and agent-workflow operations.

## Intentional CLI-only operations

- `serve` is the MCP transport itself.
- `install`, `uninstall`, and `install-hooks` mutate host/repository setup.
- `db` owns local database lifecycle and destructive confirmation boundaries.
- `llm setup/smoke` and `backend` are operator configuration/process checks.
- `doctor`, `guide`, `mcp-budget`, `completions`, and `upgrade` are operator
  workflows; MCP uses admin/playbook/status equivalents where appropriate.
- `sync-if-dirty` is the Git-hook compatibility entry point.
- `similar` is an ergonomic shortcut for graph direction `similar`.

These do not hide a coding capability from MCP. Long MCP admin operations use
bounded jobs with explicit status/cancel instead of blocking transport.

## Verification

Run the actual native surfaces:

```sh
cargo test --locked -p cartograph-cli \
  v1_1_33_cli_tree_remains_available_except_browser_viewer
cargo test --locked -p cartograph-cli \
  v1_1_33_mcp_input_contract_remains_accepted_except_retired_storage_modes
cargo test --locked -p cartograph-mcp
target/debug/cartograph --help
target/debug/cartograph serve --help
```

Then run the full workspace and live PostgreSQL/ParadeDB gates. Contract tests
catch accepted input shape; focused handler/live tests must still prove that
every mode consumes its arguments and produces real behavior.
