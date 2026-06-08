# AGENTS.md — install + bootstrap cartograph from an AI assistant

## Session handoff trigger

If the user says exactly `go`, read `NEXT_SESSION_GO.md` and begin the
first unchecked task listed there.

## Architecture rules for development

Read `docs/ARCHITECTURE.md` before architecture-sensitive changes. It is the
canonical persistent guide for Cartograph's feature-slice architecture and the
current post-migration ownership conventions.

Use feature slices, not layer-first buckets, for new code and for any
area you touch during maintenance. The platform's natural unit is the
slice boundary: MCP tool/action, CLI command/subcommand, installer flow,
index hook, language extractor, or LLM action.

Each slice should keep its contract, runtime, formatting/adapters, and
focused tests close together when practical. Use explicit types or Zod
schemas at trust boundaries, and validate data as it crosses those
boundaries.

Expected failures are return values with stable codes/messages/remediation
where possible. Reserve thrown exceptions for truly unexpected states,
programmer errors, and low-level I/O failures that cannot be handled
locally.

Prefer the simplest feature-local shape that keeps the contract explicit.
Do not add indirection unless the reason is stated in code or the
surrounding module pattern makes it obvious. Consistency matters more
than cleverness: repeated slices should look predictable.

Before declaring work done, verify it with type-checking and the smallest
relevant test set; broaden to full tests or health checks when touching
shared behavior, public CLI/MCP contracts, indexing, extraction, or LLM
flows.

## SonarQube verification for agents

Use the local Sonar credentials from `/Users/adderclaudedev/.sonarqube-env`;
do not print token values. Source it inside the command that needs it:

```sh
set -a
. /Users/adderclaudedev/.sonarqube-env
set +a
```

Scanner success is not quality-gate success. After `sonar-scanner` exits
successfully, read the CE task id for that exact scan and check the gate by
`analysisId`:

```sh
task_id=$(sed -n 's/^ceTaskId=//p' .scannerwork/report-task.txt)
task_json=$(curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
  "$SONAR_HOST_URL/api/ce/task?id=$task_id")
analysis_id=$(printf '%s' "$task_json" | jq -r '.task.analysisId')
curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
  "$SONAR_HOST_URL/api/qualitygates/project_status?analysisId=$analysis_id"
```

Report the quality-gate `projectStatus.status` separately from scanner
execution. If the gate fails, pull unresolved issues and `TO_REVIEW` hotspots
from Sonar before guessing:

```sh
curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
  "$SONAR_HOST_URL/api/issues/search?components=cartograph&issueStatuses=OPEN&ps=100&additionalFields=_all"
curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
  "$SONAR_HOST_URL/api/hotspots/search?project=cartograph&status=TO_REVIEW&ps=100"
```

Prefer Sonar's API v2 when the local server metadata says a v2 replacement
exists. Check metadata instead of guessing endpoint names:

```sh
curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
  "$SONAR_HOST_URL/api/webservices/list" |
  jq -r '.webServices[] as $ws | $ws.actions[]? as $a |
    ($a.changelog // [])[]? |
    select(.description | test("api/v2"; "i")) |
    "\($ws.path)/\($a.key) -> \(.description)"'
```

On the local SonarQube `26.5.0.122743` server, API v2 is available for some
areas such as users and authorizations, but CE task polling and quality-gate
status still use `/api/ce/task` and `/api/qualitygates/project_status`.

This file is for AI assistants (Claude Code, Cursor, Windsurf, etc.)
helping a user install cartograph. The instructions are written
sequentially so they can be followed mechanically: run a command,
verify the output, move to the next step. If a step fails, the
remediation is named in the failure-mode section at the end.

## Fast path (recommended) — use the MCP wizard

If you (the agent) can already reach cartograph's MCP tools, skip
straight to the agent-driven wizard:

1. **`cartograph_admin({action: "llm-plan"})`** — returns a structured
   plan: which LLM backends are already running on the user's machine,
   which setup presets are available (`install-ollama` /
   `install-llama-cpp` / `install-mlx` / `cloud-openai` /
   `cloud-openai-compat` / `hybrid-claude-bridge` /
   `hybrid-anthropic-api` / `use-detected-<kind>-<endpoint>` / `skip`),
   and which one the wizard recommends. Each preset has a `summary`,
   `description`, `nextSteps`, and `requiresInstall` flag.

2. **Render the presets to the user in your chat UI** and take their
   pick.

3. **`cartograph_admin({action: "llm-apply", preset: "<id>",
   projectPath: "<absolute-path>"})`** — writes
   `.cartograph/config.json` non-interactively. Returns the
   `nextSteps` the user must run (install the backend, pull models,
   start `llama-server` processes) for the configured endpoints to
   actually serve traffic.

4. **`cartograph_admin({action: "doctor", fix: true, projectPath:
   "<abs-path>"})`** — verifies the install state. With `fix: true`
   doctor auto-creates `.cartograph/`, downloads missing GGUFs, and
   applies the planner's recommended preset for missing config. The
   only thing doctor can NOT auto-fix is starting a backend process —
   cartograph doesn't manage backends, so the user runs those commands
   themselves.

The rest of this file (Step 0 onward) is the slow path — the explicit
CLI commands you'd give a user with no agent or no MCP access yet.

---

Cartograph is a local-first code-intelligence MCP server. It needs:
- **Bun ≥ 1.3.0** as its runtime
- **Storage**: SQLite by default; optional PostgreSQL 18+ when the user wants
  external/shared storage, managed backups, or native pgvector search
- An **OpenAI-compat HTTP LLM backend** running on localhost — cartograph
  recommends llama-cpp's `llama-server`, but Ollama / mlx_lm.server /
  LM Studio / vLLM / LocalAI all work. Cloud OpenAI (or any
  OpenAI-compat cloud) is also a valid pick — see the `cloud-openai` /
  `cloud-openai-compat` presets.
- **GGUF model files** under `~/.cartograph/models/` (only if running
  llama-server — Ollama / mlx_lm download models themselves; cloud
  doesn't need them)

**Migration arc 2026-05-24c (steps 1-4) deleted the in-process LLM
pathway** (mini-nllc + libcgshim + Bun.ffi). Everything LLM-related
runs over HTTP now. Old configs carrying `provider: 'nllc'` /
`provider: 'local'` auto-migrate to `provider: 'openai-compat'` at
load time with a stderr warning naming the tier + default endpoint.

---

## Step 0 — verify prerequisites

```sh
bun --version
```

Expect `1.3.x` or newer. If the command isn't found:

```sh
curl -fsSL https://bun.sh/install | bash
```

The user's shell needs to source the Bun env on the next prompt
(`source ~/.zshrc` / `source ~/.bashrc`).

---

## Step 1 — install cartograph from source

Cartograph ships source directly (no compiled `dist/`); Bun transpiles
on demand, so [Bun](https://bun.sh) ≥ 1.3 is required. Clone the repo,
install dependencies, and link the `cartograph` command onto PATH:

```sh
git clone https://github.com/adder-factory/cartograph.git
cd cartograph
bun install
bun link
```

Verify:

```sh
cartograph --version
```

Expect a version number. If the command isn't found, Bun's global
bin dir isn't on `$PATH` — run `bun pm bin -g` to print it and add
that directory to `$PATH`.

---

## Step 2 — install an LLM backend

Cartograph speaks OpenAI-compat HTTP — any backend implementing
`/v1/chat/completions` + `/v1/embeddings` works. Recommended:

### Option A — llama-cpp (recommended)

```sh
# macOS
brew install llama.cpp

# Linux / Windows: https://github.com/ggml-org/llama.cpp (build from source or use a release)
```

llama-server is one-model-per-process. Cartograph's recommended config
runs four instances on consecutive ports (one model per port). Start
all four (each in its own terminal / tmux pane / systemd unit):

```sh
# Embedding (always required)
llama-server -m ~/.cartograph/models/jina-embeddings-v2-base-code.gguf --port 8080 --embeddings

# Chat: summarize + local
llama-server -m ~/.cartograph/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf --port 8081

# Chat: ask (higher-stakes, optional — falls back to summarize)
llama-server -m ~/.cartograph/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf --port 8082

# Reranker (optional — improves semantic search precision)
llama-server -m ~/.cartograph/models/bge-reranker-v2-m3.gguf --port 8083 --rerank
```

### Option B — Ollama (simpler; auto-loads models on demand)

```sh
brew install ollama  # macOS — auto-starts as a service
# Linux: https://ollama.com

ollama pull qwen2.5-coder:3b
ollama pull nomic-embed-text
```

Then point all cartograph LLM tiers at `http://localhost:11434` — edit
`.cartograph/config.json` after `setup`. Ollama dynamically loads /
unloads models; the cold-start cost is per first-call-per-model.

### Option C — Apple MLX / LM Studio / vLLM / LocalAI / cloud OpenAI

Same OpenAI-compat shape. Set each `*Llm.endpoint` accordingly.

---

## Step 3 — bootstrap the install

```sh
cartograph setup [project-path]
```

This runs three steps in order:

1. `admin init` — creates `.cartograph/` in the project directory.
   SQLite is the zero-config storage default.
2. `install-models` — downloads the curated GGUF set into
   `~/.cartograph/models/`. ~7 GB for the full set; pass `--minimal`
   for the ~2.1 GB subset (embed + 3B chat, no 7B chat or reranker).
   Skip with `--no-models` if you're using Ollama or already have the
   GGUFs.
3. `doctor` — verifies the install state.

The recommended `.cartograph/config.json` is written by
`cartograph admin install-models --write-config` (or pass that flag to
`setup`). It points all tiers at the `localhost:808x` ports from
Option A above. If you picked Option B (Ollama), hand-edit each
`*Llm.endpoint` to `http://localhost:11434` and each `*Llm.model` to
the Ollama model id.

```sh
cartograph setup --minimal /path/to/project
```

If the user asked for PostgreSQL, start a PostgreSQL 18+ database first and
pass storage flags before the first init/setup. Do not switch storage just
because PostgreSQL is available; SQLite is the recommended local default.

```sh
docker run --rm -d --name cartograph-postgres \
  -e POSTGRES_USER=cartograph \
  -e POSTGRES_PASSWORD=cartograph \
  -e POSTGRES_DB=cartograph \
  -p 5432:5432 \
  pgvector/pgvector:pg18

cartograph setup --minimal /path/to/project \
  --database-provider postgres \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto
```

For an existing SQLite project, use `cartograph admin storage-migrate
/path/to/project --database-url <postgres-url> --database-schema <schema>`
and restart any MCP server attached to the old SQLite database. The PostgreSQL
target schema must be fresh or intentionally recreated with `--force`.

---

## Step 4 — verify

```sh
cartograph doctor
```

The output is a Markdown report with one line per check:

- `✓` — passed
- `⚠` — non-blocking gap (a remediation is suggested)
- `✗` — blocking failure (a remediation is required)

A clean install shows all checks `✓` with "_All checks passed.
cartograph is ready to use._" Doctor check areas include:

1. Bun runtime version
2. Project init (`.cartograph/` exists)
3. Project config (`config.json` parses, including storage and LLM config)
4. Database storage — SQLite capability check or PostgreSQL 18+ connectivity,
   schema, write, DDL, and pgvector checks
5. GGUF models present under `~/.cartograph/models/` when configured
6. Detected LLM backends — informational scan of common ports
   (:8080 / :11434 / :8000 / :1234 / :5000)
7. Embedding endpoint reachability — probes the configured
   `embeddingLlm.endpoint`; surfaces detected alternatives on failure
8. Backend tuning, start commands, lifecycle, and active Cartograph process
   checks when relevant

---

## Step 5 — wire cartograph into the user's AI assistant

Cartograph runs as an MCP server. The exact wiring depends on the
host AI assistant:

### Claude Code

Preferred private per-project install:

```sh
cartograph install --yes --target=claude --location=local
```

If the host cannot find `cartograph` on PATH, pass an absolute executable path:

```sh
cartograph install --yes --target=claude --location=local --command "$(command -v cartograph)"
```

That writes the MCP server into `~/.claude.json` under the current project's
path. Manual equivalent:

```json
{
  "projects": {
    "/abs/path/to/project": {
      "mcpServers": {
        "cartograph": {
          "type": "stdio",
          "command": "cartograph",
          "args": ["serve", "--mcp", "--project-path", "/abs/path/to/project"]
        }
      }
    }
  }
}
```

For team-shared Claude MCP config, use `<project>/.mcp.json` with the standard
top-level `mcpServers` shape.

Restart Claude Code (`/restart`) so it picks up the new server.

### Cursor / Windsurf / other MCP-capable hosts

Follow the host's MCP-server registration UI. The server spec is:

- command: `cartograph`
- args: `["serve", "--mcp", "--project-path", "<absolute project path>"]`
- transport: stdio

---

## Common failure modes

### `Bun: command not found`

Cartograph needs Bun. Install per Step 0. If the user has Bun but the
shell doesn't see it, they need to `source` the relevant profile.

### `LLM models ⚠ ~/.cartograph/models/ does not exist`

Models haven't been downloaded. `cartograph admin install-models`
(or `--minimal`). The download is large — warn the user before
kicking it off on a metered connection. Skip the download if the user
is using Ollama / mlx_lm (which manage their own models).

### `Project config ⚠ no llm block configured`

The `.cartograph/config.json` exists but doesn't reference the LLM
backends. Run `cartograph admin install-models --write-config` to
download + wire the recommended block in one go (creates a `.bak.<ts>`
backup if config.json already exists).

### `Database storage ✗ PostgreSQL server is too old`

Cartograph PostgreSQL storage requires PostgreSQL 18 or newer. Use a
PostgreSQL 18+ service, such as `pgvector/pgvector:pg18` for local Docker
testing, or keep the default SQLite backend.

### `Database storage ✗ PostgreSQL check failed`

Verify `database.url`, credentials, network access, and that the configured
server is running. If `database.pgvector` is `require`, make sure pgvector is
installed in that database; for local Docker tests use `pgvector/pgvector:pg18`.

### `Database storage ⚠ No SQLite database`

The project was initialized but the SQLite graph file is missing. Run
`cartograph admin init /path/to/project`, or configure PostgreSQL explicitly
with `database.provider: "postgres"` and a PostgreSQL 18+ `database.url`.

### `Embedding endpoint ⚠ http://localhost:8080 is not responding`

The configured `embeddingLlm.endpoint` isn't reachable. Two paths:

1. Start a backend at that URL. If you're on the recommended
   llama-cpp setup: `llama-server -m
   ~/.cartograph/models/jina-embeddings-v2-base-code.gguf --port 8080
   --embeddings`.
2. If `cartograph doctor` ALSO reports a "Detected LLM backends" line
   listing what IS running (e.g. "Ollama at http://localhost:11434
   (N models)"), edit `embeddingLlm.endpoint` to that URL and
   `embeddingLlm.model` to the model name the backend serves. No
   re-install required.

### `Detected LLM backends ✓ No OpenAI-compat backends running`

Nothing's running on the common ports. Pick Option A / B / C from
Step 2 and start the backend. The user only needs ONE backend for
embeddings to work; chat / rerank are separate tiers.

### `Auto-migrated legacy <tier>.provider value to "openai-compat"`

A pre-2026-05-24c config still carrying `provider: 'nllc'` (chat
tier) or `provider: 'local'` (embedding / reranker) was just
in-memory-migrated to `provider: 'openai-compat'` with the default
endpoint for that tier (8081 chat / 8080 embed / 8083 reranker). The
on-disk file is NOT modified. Run `cartograph doctor` to verify the
endpoint is up — usually it isn't (user wasn't running an HTTP
backend before), so the embedding-reachability check flags it with
the start command. The user can either (a) start the backend at the
defaulted port, or (b) hand-edit the config to point at a different
backend (Ollama, etc.).

### Reranker is configured but `isReachable()` returns false

The configured rerank backend doesn't expose `/v1/rerank`. Ollama and
mlx_lm don't today; llama-server does (with `--rerank` flag), Jina /
Voyage / Cohere do as cloud providers. Either start a llama-server
with `--rerank` at the configured `rerankerLlm.endpoint`, point that
config at a cloud rerank provider, or delete the `rerankerLlm` block
to skip reranking (semantic search still works via plain cosine).

---

## What an AI assistant should do, end to end

If the user says "install cartograph", the minimal script is:

```sh
# 0. Bun (cartograph runtime requirement)
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash

# 1. Cartograph from source
git clone https://github.com/adder-factory/cartograph.git /tmp/cartograph
(cd /tmp/cartograph && bun install && bun link)

# 2. An OpenAI-compat backend. macOS quickstart:
brew install llama.cpp  # OR: brew install ollama (simpler, auto-starts)

# 3. Bootstrap with SQLite storage (--minimal = ~2.1 GB; drop the flag for full ~7 GB)
cartograph setup --minimal /path/to/the/users/project

# 4. Start the backends (one llama-server per port — paste each in its
#    own terminal):
llama-server -m ~/.cartograph/models/jina-embeddings-v2-base-code.gguf --port 8080 --embeddings &
llama-server -m ~/.cartograph/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf --port 8081 &

# 5. Verify
cartograph doctor /path/to/the/users/project
```

If the user asked for PostgreSQL instead of SQLite, start PostgreSQL 18+ first
and pass storage flags during setup:

```sh
docker run --rm -d --name cartograph-postgres \
  -e POSTGRES_USER=cartograph \
  -e POSTGRES_PASSWORD=cartograph \
  -e POSTGRES_DB=cartograph \
  -p 5432:5432 \
  pgvector/pgvector:pg18

cartograph setup --minimal /path/to/the/users/project \
  --database-provider postgres \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto
```

If the user picked Ollama instead, after the `setup` step:

```sh
ollama pull qwen2.5-coder:3b
ollama pull nomic-embed-text
# Then edit .cartograph/config.json — set every *Llm.endpoint to
# http://localhost:11434 and update each *Llm.model to the Ollama
# model name.
cartograph doctor
```

If `doctor` shows ✓ for all checks, tell the user the wiring for
their AI assistant (Step 5 of this guide) and you're done.

If `doctor` shows ⚠ or ✗, follow the remediation message printed in
the report.

---

## Where to look when something else breaks

- `src/installer/doctor/` — every doctor check + remediation module.
  Add a new check by extending the focused module and wiring it in
  `src/installer/doctor/checks.ts`.
- `src/installer/scan-backends.ts` — the per-port LLM-backend
  detector. Extend `SCAN_TARGETS` to probe additional well-known
  ports.
- `src/installer/recommended-config.ts` — the per-tier port layout
  the recommended config writes. Edit the `ENDPOINT_*` constants to
  shift the default ports.
- `src/llm/openai-sdk-{chat,embedding,reranker}-client.ts` — the
  three HTTP clients. Each follows the same constructor / `isReachable`
  / error-wrapping pattern.
- `src/config.ts` — `migrateLegacyProviderValue` handles the legacy
  `'nllc'` / `'local'` auto-translation at config-load time.
