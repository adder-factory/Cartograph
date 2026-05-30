<div align="center">

# Cartograph

### Supercharge Claude Code with Semantic Code Intelligence

**45% fewer tool calls · 17% faster exploration · 100% local**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#)

<br />

</div>

> **Cartograph** is a fork of [**codegraph**](https://github.com/colbymchenry/codegraph) by Colby Mchenry, used under the MIT License. It pivots codegraph's LLM layer from in-process (libllama via Bun FFI) to OpenAI-compatible HTTP — embedding, chat, and rerank each run against a backend you choose per tier (llama-cpp's `llama-server`, Ollama, Apple MLX's `mlx_lm.server`, LM Studio, vLLM, LocalAI, or a cloud OpenAI-compatible provider). See [`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md) for full credits.

## Get Started

Cartograph runs on [Bun](https://bun.sh) ≥ 1.3 and is currently distributed from source (an npm package is not published yet):

```bash
git clone https://github.com/adder-factory/Cartograph.git
cd Cartograph
bun install
bun link                  # puts the `cartograph` command on your PATH
```

Then add a local LLM backend and let `cartograph` configure your agent:

```bash
# A backend (macOS quickstart — pick one):
brew install llama.cpp    # OR: brew install ollama (simpler, auto-starts as a service)

# Configure your AI agent(s) — auto-detects Claude Code / Cursor / Codex CLI / opencode
cartograph install

# One-shot bootstrap for a project — diagnose + auto-fix what doctor can fix
cartograph doctor --fix /path/to/your/project

# `doctor --fix` creates .cartograph/, downloads missing GGUFs, and writes the
# recommended config. Starting the LLM backend(s) stays manual; doctor prints
# the exact commands. For llama-cpp, run one llama-server per tier:
llama-server -m ~/.cartograph/models/jina-embeddings-v2-base-code.gguf --port 8080 --embeddings &
llama-server -m ~/.cartograph/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf --port 8081 &

# Re-verify after starting backends
cartograph doctor /path/to/your/project
```

**Using an AI assistant?** Any MCP-capable agent (Claude Code, Cursor, Windsurf, Codex CLI, opencode, LangChain, OpenAI Agent SDK, …) can drive the install via two MCP tools: `cartograph_admin({action: "llm-plan"})` returns the available setup presets (Ollama / llama-cpp / Apple MLX / cloud OpenAI / cloud OpenAI-compat / hybrid Claude-for-ask), and `cartograph_admin({action: "llm-apply", preset: "<id>", projectPath: "<abs>"})` writes the config and lists next-step commands. See [`AGENTS.md`](./AGENTS.md) for the full script.

---

## Why Cartograph?

When Claude Code explores a codebase, it spawns **Explore agents** that scan files with grep, glob, and Read — consuming tokens on every tool call.

**Cartograph gives those agents a pre-indexed knowledge graph** — symbol relationships, call graphs, and code structure. Agents query the graph instantly instead of scanning files.

### Benchmark Results

Tested across 7 real-world OSS codebases, comparing a headless `claude -p` agent **with** and **without** Cartograph's MCP — cartograph is the only variable.

> **Average: 5% cheaper · 0% fewer tokens · 17% faster · 45% fewer tool calls**

| Codebase | Language | Cost | Tokens | Time | Tool calls |
|---|---|---|---|---|---|
| **axum** | Rust | **38% cheaper** | **10% fewer** | **37% faster** | **53% fewer** |
| **fastapi** | Python | **14% cheaper** | 3% more | **24% faster** | **65% fewer** |
| **framework** | PHP | **6% cheaper** | **0% fewer** | **25% faster** | **65% fewer** |
| **gin** | Go | 22% pricier | 2% more | **10% faster** | **19% fewer** |
| **ktor** | Kotlin | **2% cheaper** | **1% fewer** | **9% faster** | **46% fewer** |
| **nest** | TypeScript | **8% cheaper** | 2% more | **18% faster** | **80% fewer** |
| **spring-petclinic** | Java | 11% pricier | 1% more | 6% slower | 11% more |

The headline win is **fewer tool calls and faster exploration** — cartograph replaces the agent's glob/grep/find discovery hunting with targeted graph queries. Cost savings are real but small and token use is roughly flat — and on a couple of repos cartograph costs slightly more: `spring-petclinic` (a 76-file toy app) is the one repo that's both pricier and slower, where cartograph's fixed handshake overhead isn't offset; `gin` is 22% pricier but still 10% faster. `cartograph_explore` returns large rich context that trades against the file-read savings.

<details>
<summary><strong>Full benchmark details</strong></summary>

_Measured 2026-05-29 on `wip`, Claude Opus (claude 2.1.157) via `claude -p`. Cartograph LLM backend: local llama-server (jina-embeddings-v2-base-code :8080, Qwen2.5-Coder-3B :8081). Median of 4 runs per arm; 0 dropped._

Methodology: each arm is `claude -p` (Claude Opus) run headlessly with `--strict-mcp-config`. **With** = Cartograph MCP enabled; **without** = empty MCP config; built-in Read/Grep/Bash available to both — so Cartograph is the only variable. Same question per repo, median of 4 runs per arm, natural agent behavior — no eval-specific steering prompt, though both arms inherit the user's standard global config (which recommends cartograph when a `.cartograph` index is present, as a real install has). Cost = `total_cost_usd` (API-equivalent — on a Max subscription this is accounting, not billing); Tokens = input incl. cached + output; Time = wall-clock. **Tool calls** is the true total — it includes every call the agent's Explore sub-agent makes: `claude -p --verbose` inlines a delegated sub-agent's tool calls into the main transcript (same tool_use ids), so the count is already complete (the harness de-duplicates by id to avoid double-counting). **Tokens**, by contrast, are main-thread-only: `claude`'s `result.usage` excludes a delegated sub-agent's token use, so when the agent delegates the token figure is a conservative lower bound. The clearest, lowest-variance win is tool-call reduction (fewer discovery round-trips); cost/tokens are closer because `cartograph_explore` returns large rich context that offsets the file-read savings.

With cartograph available, the agent engaged it in **28 of 28** `with`-arm runs. A run that ignores an available cartograph measures tool-choice variance, not cartograph's value; such runs are flagged and kept in the medians (never dropped — dropping would bias the result toward cartograph).

**Raw medians — WITH → WITHOUT:**

| Codebase | Cost | Tokens | Time | Tool calls |
|---|---|---|---|---|
| axum | $0.39 → $0.62 | 56k → 62k | 1m 51s → 2m 56s | 20 → 42.5 |
| fastapi | $0.28 → $0.33 | 57k → 55k | 1m 37s → 2m 7s | 9.5 → 27 |
| framework | $0.34 → $0.37 | 57k → 57k | 1m 45s → 2m 21s | 11 → 31.5 |
| gin | $0.36 → $0.29 | 57k → 56k | 1m 43s → 1m 54s | 11 → 13.5 |
| ktor | $0.39 → $0.40 | 64k → 64k | 2m 9s → 2m 22s | 15 → 28 |
| nest | $0.29 → $0.32 | 58k → 57k | 1m 43s → 2m 6s | 5 → 25 |
| spring-petclinic | $0.24 → $0.21 | 53k → 53k | 1m 21s → 1m 17s | 19.5 → 17.5 |

Reproduce: `node scripts/agent-eval/run-sweep.mjs --publish --runs 4` — the harness, the 7 corpora, and their per-repo queries all live in [`scripts/agent-eval/`](./scripts/agent-eval/) (corpora are pre-indexed locally; results land in `scripts/agent-eval/results/`).

</details>

---

## Key Features

| | |
|---|---|
| **Smart Context Building** | One tool call returns entry points, related symbols, and code snippets — no expensive exploration agents |
| **Full-Text + Intent Search** | Find code by name (FTS5) OR by behavior — `mode='intent'` runs FTS5 over LLM-generated summaries so you can locate "the function that verifies JWT signatures" even when its name is `processBatch` |
| **Impact Analysis** | Trace callers, callees, and the full impact radius of any symbol before making changes |
| **Always Fresh** | File watcher uses native OS events (FSEvents/inotify/ReadDirectoryChangesW) with debounced auto-sync — the graph stays current as you code, zero config |
| **31 Languages** | TypeScript, Python, Go, Rust, Java, C/C++, C#, Swift, Kotlin, Scala, Ruby, PHP, Dart, Lua, R, ReScript, Elixir, shells (Bash/Zsh/Fish), HCL, SQL, GraphQL, Prisma, and more — see [Supported Languages](#supported-languages) |
| **100% Local** | No data leaves your machine. No API keys. No external services. SQLite database only |

---

## Quick Start

### 1. Run the Installer

```bash
cartograph install
```

The installer will:
- Prompt to install `cartograph` globally (needed for the MCP server)
- Ask which agent(s) to configure — auto-detects installed ones from: **Claude Code**, **Cursor**, **Codex CLI**, **opencode**
- Write each chosen agent's MCP server config + an instructions file (e.g. `CLAUDE.md`, `.cursor/rules/cartograph.mdc`, `~/.codex/AGENTS.md`)
- Set up auto-allow permissions for the chosen agent (Claude Code only)
- Optionally initialize your current project

**Non-interactive (scripting / CI):**

```bash
cartograph install --yes                              # auto-detect agents, install global
cartograph install --target=cursor,claude --yes       # explicit target list
cartograph install --target=auto --location=local     # detected agents, project-local
cartograph install --print-config codex               # print snippet, no file writes
```

| Flag | Values | Default |
|---|---|---|
| `--target` | `auto`, `all`, `none`, or csv (`claude,cursor,...`) | prompt |
| `--location` | `global`, `local` | prompt |
| `--yes` | (boolean) | prompt every step |
| `--no-permissions` | (boolean) skip Claude auto-allow list | permissions on |
| `--print-config <id>` | dump snippet for one agent and exit | — |

### 2. Restart Your Agent

Restart your agent (Claude Code / Cursor / Codex CLI / opencode) for the MCP server to load.

### 3. Initialize Projects

```bash
cd your-project
cartograph init -i
```

That's it! Claude Code will use Cartograph tools automatically when a `.cartograph/` directory exists.

<details>
<summary><strong>Manual Setup (Alternative)</strong></summary>

**Install from source:**
```bash
git clone https://github.com/adder-factory/Cartograph.git && cd Cartograph && bun install && bun link
```

**Add to `~/.claude.json`:**
```json
{
  "mcpServers": {
    "cartograph": {
      "type": "stdio",
      "command": "cartograph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**Add to `~/.claude/settings.json` (optional, for auto-allow):**
```json
{
  "permissions": {
    "allow": [
      "mcp__cartograph__cartograph_search",
      "mcp__cartograph__cartograph_context",
      "mcp__cartograph__cartograph_callers",
      "mcp__cartograph__cartograph_callees",
      "mcp__cartograph__cartograph_impact",
      "mcp__cartograph__cartograph_node",
      "mcp__cartograph__cartograph_status",
      "mcp__cartograph__cartograph_files"
    ]
  }
}
```

</details>

<details>
<summary><strong>Global Instructions Reference</strong></summary>

The installer automatically adds these instructions to `~/.claude/CLAUDE.md`:

```markdown
## Cartograph

Cartograph builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If `.cartograph/` exists in the project

**NEVER call `cartograph_explore` or `cartograph_context` directly in the main session.** These tools return large amounts of source code that fills up main session context. Instead, ALWAYS spawn an Explore agent for any exploration question (e.g., "how does X work?", "explain the Y system", "where is Z implemented?").

**When spawning Explore agents**, include this instruction in the prompt:

> This project has Cartograph initialized (.cartograph/ exists). Use `cartograph_explore` as your PRIMARY tool — it returns full source code sections from all relevant files in one call.
>
> **Rules:**
> 1. Follow the explore call budget in the `cartograph_explore` tool description — it scales automatically based on project size.
> 2. Do NOT re-read files that cartograph_explore already returned source code for. The source sections are complete and authoritative.
> 3. Only fall back to grep/glob/read for files listed under "Additional relevant files" if you need more detail, or if cartograph returned no results.

**The main session may only use these lightweight tools directly** (for targeted lookups before making edits, not for exploration):

| Tool | Use For |
|------|---------|
| `cartograph_search` | Find symbols by name (modes: `exact` / `fuzzy` / `semantic` / `intent`) |
| `cartograph_callers` / `cartograph_callees` | Trace call flow |
| `cartograph_impact` | Check what's affected before editing |
| `cartograph_node` | Get a single symbol's details — or up to 20 in one call via `symbols`; optional `includeCallers` / `includeCallees` / `includeBiomarkers` / `includeTests` fold the answer of those tools into the same response |
| `cartograph_at_range` | Symbols overlapping a file:line span (PR-review hunks); pass `ranges: [...]` to query multiple hunks in one call |

### If `.cartograph/` does NOT exist

At the start of a session, ask the user if they'd like to initialize Cartograph:

"I notice this project doesn't have Cartograph initialized. Would you like me to run `cartograph init -i` to build a code knowledge graph?"
```

</details>

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
│                                                                  │
│  "Implement user authentication"                                 │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │  Explore Agent  │ ──── │  Explore Agent  │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                             │
└───────────┼────────────────────────┼─────────────────────────────┘
            │                        │
            ▼                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     Cartograph MCP Server                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │   Search    │  │   Callers   │  │   Context   │               │
│  │  "auth"     │  │  "login()"  │  │  for task   │               │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │
│         │                │                │                       │
│         └────────────────┼────────────────┘                       │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │   SQLite Graph DB     │                            │
│              │   • 387 symbols       │                            │
│              │   • 1,204 edges       │                            │
│              │   • Instant lookups   │                            │
│              └───────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
```

1. **Extraction** — [tree-sitter](https://tree-sitter.github.io/) parses source code into ASTs. Language-specific queries extract nodes (functions, classes, methods) and edges (calls, imports, extends, implements).

2. **Storage** — Everything goes into a local SQLite database (`.cartograph/cartograph.db`) with FTS5 full-text search.

3. **Resolution** — After extraction, references are resolved: function calls → definitions, imports → source files, class inheritance, and framework-specific patterns.

4. **Auto-Sync** — The MCP server watches your project using native OS file events. Changes are debounced (2-second quiet window), filtered to source files only, and incrementally synced. The graph stays fresh as you code — no configuration needed.

---

## CLI Reference

```bash
cartograph                         # Run interactive installer
cartograph install                 # Run installer (explicit)
cartograph init [path]             # Initialize in a project (--index to also index)
cartograph uninit [path]           # Remove Cartograph from a project (--force to skip prompt)
cartograph index [path]            # Full index (--force to re-index, --quiet for less output)
cartograph sync [path]             # Incremental update
cartograph status [path]           # Show statistics
cartograph query <search>          # Search symbols (--kind, --limit, --json)
cartograph files [path]            # Show file structure (--format, --filter, --max-depth, --json)
cartograph context <task>          # Build context for AI (--format, --max-nodes)
cartograph affected [files...]     # Find test files affected by changes (see below)
cartograph serve --mcp             # Start MCP server
```

### `cartograph affected`

Traces import dependencies transitively to find which test files are affected by changed source files.

```bash
cartograph affected src/utils.ts src/api.ts         # Pass files as arguments
git diff --name-only | cartograph affected --stdin   # Pipe from git diff
cartograph affected src/auth.ts --filter "e2e/*"     # Custom test file pattern
```

| Option | Description | Default |
|--------|-------------|---------|
| `--files <paths...>` | Alias for the positional file arguments | — |
| `--stdin` | Read file list from stdin | `false` |
| `-d, --depth <n>` | Max dependency traversal depth | `5` |
| `-f, --filter <glob>` | Custom glob to identify test files | auto-detect |
| `-j, --json` | Output as JSON | `false` |
| `-q, --quiet` | Output file paths only | `false` |

Paths passed explicitly that aren't in the index are rejected with an error and a non-zero exit code.

**CI/hook example:**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | cartograph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

---

## MCP Tools

When running as an MCP server, Cartograph exposes these tools to any MCP-compatible AI assistant:

| Tool | Purpose |
|------|---------|
| `cartograph_search` | Find symbols by name (`exact`/`fuzzy`) or by behavior (`semantic`/`intent` over LLM summaries) |
| `cartograph_context` | Build relevant code context for a task |
| `cartograph_callers` | Find what calls a function |
| `cartograph_callees` | Find what a function calls |
| `cartograph_impact` | Analyze what code is affected by changing a symbol |
| `cartograph_node` | Get details about one symbol (or up to 20 via `symbols`), optionally with source code, callers, callees, biomarkers, or tests folded inline |
| `cartograph_files` | Get indexed file structure (faster than filesystem scanning) |
| `cartograph_status` | Check index health and statistics; pass `topHotspots: N` / `topBiomarkers: N` to fold those tools' rollups into the same response (onboarding "what's interesting?" in one call) |

---

## Using with Other MCP Clients

The MCP server runs over **stdio** and works with any MCP-compatible client — not just Claude Code. The interactive installer is Claude Code-specific (it writes `~/.claude.json`), so for other clients you'll want the manual setup.

**Common steps for every client:**

```bash
# install Cartograph from source first (see Get Started) so `cartograph` is on PATH
cd your-project
cartograph init -i                           # initialize + index this project
```

Then point your MCP client at `cartograph serve --mcp` using whatever config shape it expects:

### opencode

In `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cartograph": {
      "type": "local",
      "command": ["cartograph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

### LangChain (`MultiServerMCPClient`)

The Cartograph server speaks stdio, not SSE — pass `transport: "stdio"`:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "cartograph": {
        "command": "cartograph",
        "args": ["serve", "--mcp"],
        "transport": "stdio",
    }
})
tools = await client.get_tools()
```

### Claude Agent SDK

Pass the server in `mcpServers` (TypeScript) or `mcp_servers` (Python) when calling `query()`:

```python
from claude_agent_sdk import query, ClaudeAgentOptions

options = ClaudeAgentOptions(
    mcp_servers={
        "cartograph": {
            "command": "cartograph",
            "args": ["serve", "--mcp"],
        }
    },
    allowed_tools=["mcp__cartograph__*"],
)

async for message in query(prompt="Where is auth handled?", options=options):
    ...
```

### Anything else (generic stdio MCP)

Most MCP clients (Continue, Zed, custom integrations, etc.) accept some variation of `command` + `args`. The values are always:

| Field | Value |
|-------|-------|
| Command | `cartograph` |
| Args | `["serve", "--mcp"]` |
| Transport | `stdio` |

The server reads the project root from the MCP `initialize` request's `rootUri` (set by the client when it connects). If your client doesn't send a `rootUri`, pass the project path explicitly:

```bash
cartograph serve --mcp --path /absolute/path/to/project
```

> **Note:** Cartograph's MCP server does **not** speak SSE/HTTP. If your client only supports `url` + `transport: "sse"`, you'll need to wrap stdio with a bridge like [supergateway](https://github.com/supercorp-ai/supergateway).

---

## Library Usage

```typescript
import Cartograph from '@adder-factory/cartograph';

const cg = await Cartograph.init('/path/to/project');
// Or: const cg = await Cartograph.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`)
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // auto-sync on file changes
cg.unwatch(); // stop watching
cg.close();
```

---

## Configuration

The `.cartograph/config.json` file controls indexing:

```json
{
  "version": 1,
  "languages": ["typescript", "javascript"],
  "exclude": ["node_modules/**", "dist/**", "build/**", "*.min.js"],
  "frameworks": [],
  "maxFileSize": 1048576,
  "extractDocstrings": true,
  "trackCallSites": true
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `languages` | Languages to index (auto-detected if empty) | `[]` |
| `exclude` | Glob patterns to ignore | `["node_modules/**", ...]` |
| `frameworks` | Framework hints for better resolution | `[]` |
| `maxFileSize` | Skip files larger than this (bytes) | `1048576` (1MB) |
| `extractDocstrings` | Extract docstrings from code | `true` |
| `trackCallSites` | Track call site locations | `true` |

## Supported Languages

| Language | Extension | Status |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx` | Full support |
| JavaScript | `.js`, `.jsx`, `.mjs` | Full support |
| Python | `.py` | Full support |
| Go | `.go` | Full support |
| Rust | `.rs` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support |
| PHP | `.php` | Full support |
| Ruby | `.rb` | Full support |
| C | `.c`, `.h` | Full support |
| C++ | `.cpp`, `.hpp`, `.cc` | Full support |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |
| Dart | `.dart` | Full support |
| Svelte | `.svelte` | Full support (script extraction, Svelte 5 runes, SvelteKit routes) |
| Liquid | `.liquid` | Full support |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | Full support (classes, records, interfaces, enums, DFM/FMX form files) |
| Scala | `.scala`, `.sc` | Full support |
| ReScript | `.res`, `.resi` | Full support |
| R | `.r` | Full support |
| Lua | `.lua` | Full support (`function M:foo()` colon syntax → `method` nodes) |
| Elixir | `.ex`, `.exs` | Baseline support via the `tags.scm` fallback extractor (definitions + call references) |
| Bash | `.sh`, `.bash` | Full support (functions, variables, command calls) |
| Zsh | `.zsh`, `.zshrc`, `.zshenv` | Full support (functions, variables, command calls) |
| Fish | `.fish` | Full support (functions, variables, command calls) |
| GraphQL | `.graphql`, `.gql` | Full support (SDL — types, fields, enums, interfaces) |
| SQL | `.sql`, `.ddl`, `.dml` | Full support (DDL — tables, views, functions, foreign keys) |
| HCL / Terraform | `.tf`, `.tfvars`, `.hcl` | Full support (resources, variables, outputs) |
| Prisma | `.prisma` | Full support (models, composite types, enums → struct / field / enum_member) |

Embedded schema DSLs are recognised inside their host language too — a Zod schema (TS/JS) or a Pydantic model (Python) yields `struct` / `field` / `enum_member` nodes, not an opaque constant.

Want to add another language? See [`docs/ADDING-A-LANGUAGE.md`](docs/ADDING-A-LANGUAGE.md) — it walks through sourcing a tree-sitter grammar, probing the AST, choosing between the OO and self-contained extractor patterns, and the worked examples in the existing extractors.

## Troubleshooting

**"Cartograph not initialized"** — Run `cartograph init` in your project directory first.

**Indexing is slow** — Check that `node_modules` and other large directories are excluded. Use `--quiet` to reduce output overhead.

**Indexing is slow / WASM fallback active** — `cartograph` ships with a WASM SQLite fallback for environments where `better-sqlite3` (a native module, declared as `optionalDependencies`) can't install. The fallback is 5-10x slower than the native backend. Run `cartograph status` and look at the `Backend:` line:

- `Backend: native (better-sqlite3)` — you're on the fast path, nothing to do.
- `Backend: ⚠ wasm` — you're on the slow fallback. Common causes: missing C build tools, prebuilt binary unavailable for your Node version, or your Node version changed after install. Fix:

  ```bash
  # macOS
  xcode-select --install                                  # installs the C compiler

  # Linux (Debian / Ubuntu)
  sudo apt install build-essential python3 make

  # Linux (RHEL / Fedora)
  sudo yum groupinstall "Development Tools"

  # Then rebuild on any platform:
  npm rebuild better-sqlite3

  # Or force-include as a hard dep:
  npm install better-sqlite3 --save
  ```

  After the fix, `cartograph status` should show `Backend: native`.

**MCP server not connecting** — Ensure the project is initialized/indexed, verify the path in your MCP config, and check that `cartograph serve --mcp` works from the command line.

**Missing symbols** — The MCP server auto-syncs on save (wait a couple seconds). Run `cartograph sync` manually if needed. Check that the file's language is supported and isn't excluded by config patterns.

## License

MIT

---

<div align="center">

**Made for the Claude Code community**

[Report Bug](https://github.com/adder-factory/Cartograph/issues) · [Request Feature](https://github.com/adder-factory/Cartograph/issues)

</div>
