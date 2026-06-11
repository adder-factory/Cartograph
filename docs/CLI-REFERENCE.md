# CLI Reference

Use `cartograph --help` and `cartograph <command> --help` as the canonical
runtime reference. This page groups the top-level commands by workflow.

## Setup And Operations

```sh
cartograph install                 # interactive agent setup
cartograph install --yes --location=local   # one command: MCP config + init + index + git hooks
cartograph install --yes --location=global  # MCP config only, available in all projects
cartograph install --yes --location=local --no-hooks
cartograph install --print-config codex
cartograph install --command /absolute/path/to/cartograph
cartograph install-hooks [path]    # manage the git hooks separately
cartograph install-hooks --remove
cartograph upgrade                 # check for a newer Cartograph (alias: update)
cartograph upgrade --apply         # fast-forward a source checkout + bun install
cartograph quickstart [path]       # initialize + structural index + doctor; no model download
cartograph guide                   # compact first-use and daily-workflow guide
cartograph setup [path]            # LLM bootstrap: init + install-models + doctor
cartograph doctor [path]           # diagnose install/storage/LLM state
cartograph backend status [path]   # managed local llama-server status
cartograph backend start [path]    # start configured local llama-server tiers
cartograph backend stop [path]     # stop managed backend processes
cartograph backend logs [path]     # tail backend logs; add --tier embed|ask|rerank
cartograph status [path]           # index status and feature readiness
cartograph status [path] --json    # automation shape: version, index path,
                                   # last indexed timestamp, counts, rollups
cartograph host --mode diagnostics # MCP profile/tool and installer target signals
cartograph host --mode discover    # find .cartograph indexes under a parent path
cartograph viewer [path]           # local graph viewer
cartograph serve --mcp             # MCP server over stdio
cartograph mcp-budget              # MCP startup payload measurement
cartograph playbook                # tool-selection playbook
cartograph completions bash        # shell completions: bash, zsh, fish, powershell
```

Supported install target ids: `claude`, `cursor`, `codex`, `copilot`,
`codebuddy`, `codewhale`, `zed`, `opencode`, `hermes`, `gemini`,
`antigravity`, `kiro`, `factory`, `rovo`, `qoder`, `bob`, `kimi`, `pi`, and
`reasonix`.

For `--location=local`, generated project config and instruction files are
added to `.gitignore` because local MCP entries can contain absolute checkout
paths and personal agent rules. Local MCP server args are pinned with
`--project-path` where the client config is project-scoped. Claude Code is a
special case: `~/.claude.json` stores the private project-scoped MCP entry,
while `.claude/settings.local.json` and `CLAUDE.local.md` stay in the
repository worktree as gitignored files.

Install completions by loading the generated script in your shell startup file,
for example `cartograph completions zsh` or `cartograph completions powershell`
in your PowerShell profile.

When `cartograph` is not resolvable on PATH at install time, the installer
pins an absolute executable path into each MCP config entry automatically
(keeping the normal `serve --mcp` args). Use `cartograph install --command
<path>` to set the path explicitly, e.g. when the MCP host's GUI shell has a
different PATH than your terminal.

Local installs append managed `post-merge`, `post-checkout`, and
`post-rewrite` hook blocks that run `cartograph admin sync --quiet` in the
background; skip with `--no-hooks`. `cartograph install-hooks` manages the
same blocks separately (existing hook content is preserved, and `--remove`
deletes only Cartograph's managed block).

## Admin

```sh
cartograph admin init [path]       # create .cartograph/
cartograph admin init -i [path]    # initialize and index
cartograph admin sync [path]       # incremental update
cartograph admin index [path]      # full reindex
cartograph admin storage-migrate   # SQLite <-> PostgreSQL
cartograph admin unlock            # clear stale lock
cartograph admin prune-store       # clean old orphaned LLM store rows
```

PostgreSQL 18+ storage flags are available on `setup` and `admin init`:

```sh
cartograph admin init -i \
  --database-provider postgres \
  --database-url "$DATABASE_URL" \
  --database-schema cartograph \
  --database-pgvector auto
```

`admin storage-migrate` defaults to a PostgreSQL target when PostgreSQL flags
are provided. To move an existing PostgreSQL-backed project back to SQLite, run:

```sh
cartograph admin storage-migrate /path/to/project --database-provider sqlite
```

See [Storage Backends](STORAGE-BACKENDS.md).

Indexing commands accept `--max-file-size <size>` when generated files or
large fixtures need a one-off cap change. Values can be bytes (`1048576`) or
use a binary suffix such as `512kb` or `10mb`. The default remains 5 MiB and
explicit overrides are capped at 10 MiB. On `admin init`, the value is saved
as `config.maxFileSize`; on `admin index`, `admin sync`, `admin embed-only`,
and `sync-if-dirty`, it applies only to that run.

## Search And Navigation

```sh
cartograph find "AuthService" --by name --mode fuzzy
cartograph find "process.env.API_KEY" --by content
cartograph graph AuthService --direction callers
cartograph graph AuthService --direction impact --hops 2
cartograph export --format mermaid --kind class,method --edge-kind calls --out graph.mmd
cartograph node AuthService --include-callers --include-tests
cartograph context "fix login timeout" --format plan
cartograph explore billing routes
cartograph files src --format tree
cartograph files src/billing/service.ts --format deps
cartograph files src/billing/service.ts --format symbols
cartograph files src/billing --format module
cartograph entry-points
```

See [Graph Export Formats](GRAPH-EXPORT-FORMATS.md) for the JSON and
Cytoscape artifact contracts.

## Review And Risk

```sh
cartograph review context --diff "$(git diff)"
cartograph review risk --top-n 10
cartograph review trust
cartograph review agent-audit
cartograph biomarkers --min-severity warning
cartograph hotspots
cartograph dead-code
cartograph deps
cartograph deps --mode coverage
cartograph coverage AuthService
cartograph trace-to-culprits --trace "$STACK_TRACE"
```

## Session State And Notes

```sh
cartograph session list
cartograph session audit
cartograph session usage
cartograph session macro-list
cartograph note list
```

`session usage` reports aggregate tool-call counts and timing summaries only;
it does not print raw tool arguments or result bodies.

## Change And Test Selection

```sh
cartograph affected                      # derive files from git diff HEAD
cartograph affected src/auth.ts          # explicit files
git diff --name-only | cartograph affected --stdin
cartograph affected --include-commands
cartograph tests-for AuthService
cartograph compare-to-ref --findings-delta
cartograph changed-since
cartograph sync-if-dirty --quiet
```

`sync-if-dirty` is a compatibility command for hooks that should avoid work on
clean git trees. Prefer `cartograph admin sync` for normal interactive syncs.

## History And Refactors

```sh
cartograph blame AuthService
cartograph history AuthService
cartograph propose-rename AuthService LoginService
cartograph imports src/auth
cartograph similar AuthService
```

## LLM-Backed Commands

These require configured OpenAI-compatible chat/embedding providers:

```sh
cartograph llm setup
cartograph llm smoke --timeout-ms 60000
cartograph ask "How does auth work?"
cartograph ask --mode local_chat --prompt "Summarize this report"
cartograph summaries pending
cartograph role
```

Core search, graph, impact, status, affected-tests, biomarkers, and review
commands do not require an LLM.

## Read-Only SQL

```sh
cartograph sql --schema
cartograph sql "SELECT kind, COUNT(*) FROM nodes GROUP BY kind"
```

`cartograph sql` is intentionally read-only. Use curated commands first; SQL is
the escape hatch when the higher-level tools cannot compose the query.
