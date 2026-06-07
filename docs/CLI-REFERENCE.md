# CLI Reference

Use `cartograph --help` and `cartograph <command> --help` as the canonical
runtime reference. This page groups the top-level commands by workflow.

## Setup And Operations

```sh
cartograph install                 # configure supported agents
cartograph install --yes --target=auto --location=local
cartograph install --yes --target=auto --location=global
cartograph install --print-config codex
cartograph setup [path]            # init + install-models + doctor
cartograph doctor [path]           # diagnose install/storage/LLM state
cartograph status [path]           # index status and feature readiness
cartograph viewer [path]           # local graph viewer
cartograph serve --mcp             # MCP server over stdio
cartograph mcp-budget              # MCP startup payload measurement
```

Supported install target ids: `claude`, `cursor`, `codex`, `opencode`,
`hermes`, `gemini`, `antigravity`, `kiro`, `factory`, `rovo`, and `qoder`.

## Admin

```sh
cartograph admin init [path]       # create .cartograph/
cartograph admin init -i [path]    # initialize and index
cartograph admin sync [path]       # incremental update
cartograph admin index [path]      # full reindex
cartograph admin storage-migrate   # SQLite -> PostgreSQL
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

See [Storage Backends](STORAGE-BACKENDS.md).

Indexing commands accept `--max-file-size <bytes>` when generated files or
large fixtures need a one-off cap change. On `admin init`, the value is saved
as `config.maxFileSize`; on `admin index`, `admin sync`, and
`admin embed-only`, it applies only to that run.

## Search And Navigation

```sh
cartograph find "AuthService" --by name --mode fuzzy
cartograph find "process.env.API_KEY" --by content
cartograph graph AuthService --direction callers
cartograph graph AuthService --direction impact --hops 2
cartograph node AuthService --include-callers --include-tests
cartograph context "fix login timeout" --format plan
cartograph explore billing routes
cartograph files src --format tree
cartograph module src/billing
cartograph entry-points
```

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
```

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
cartograph llm smoke
cartograph ask "How does auth work?"
cartograph local-chat "Summarize this report"
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
