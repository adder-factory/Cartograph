<div align="center">

# Cartograph

### Supercharge Claude Code with Semantic Code Intelligence

**Fewer tool calls · Faster exploration · 100% local**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#)

<br />

</div>

> **Cartograph** is a fork of [**codegraph**](https://github.com/colbymchenry/codegraph) by Colby Mchenry, used under the MIT License. It pivots codegraph's LLM layer from in-process (libllama via Bun FFI) to OpenAI-compatible HTTP — embedding, chat, and rerank each run against a backend you choose per tier (llama-cpp's `llama-server`, Ollama, Apple MLX's `mlx_lm.server`, LM Studio, vLLM, LocalAI, or a cloud OpenAI-compatible provider). See [`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md) for full credits.

## Get Started

Cartograph runs on [Bun](https://bun.sh) ≥ 1.3 and is currently distributed from source (an npm package is not published yet):

```bash
git clone https://github.com/adder-factory/cartograph.git
cd cartograph
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

---

## Key Features

| | |
|---|---|
| **Smart Context Building** | One tool call returns entry points, related symbols, and code snippets — no expensive exploration agents |
| **Full-Text + Intent Search** | Find code by name (FTS5) OR by behavior — `mode='intent'` runs FTS5 over LLM-generated summaries so you can locate "the function that verifies JWT signatures" even when its name is `processBatch` |
| **Impact Analysis** | Trace callers, callees, and the full impact radius of any symbol before making changes |
| **Always Fresh** | File watcher uses native OS events (FSEvents/inotify/ReadDirectoryChangesW) with debounced auto-sync — the graph stays current as you code, zero config |
| **31 Languages** | TypeScript, Python, Go, Rust, Java, C/C++, C#, Objective-C, Swift, Kotlin, Scala, Ruby, PHP, Dart, Vue, Svelte, Lua, R, ReScript, Elixir, shells (Bash/Zsh/Fish), HCL, SQL, GraphQL, Prisma, and more — see [Supported Languages](#supported-languages) |
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
cartograph admin init -i
```

That's it! Claude Code will use Cartograph tools automatically when a `.cartograph/` directory exists.

<details>
<summary><strong>Manual Setup (Alternative)</strong></summary>

**Install from source:**
```bash
git clone https://github.com/adder-factory/cartograph.git && cd cartograph && bun install && bun link
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
      "mcp__cartograph__cartograph_find",
      "mcp__cartograph__cartograph_context",
      "mcp__cartograph__cartograph_graph",
      "mcp__cartograph__cartograph_node",
      "mcp__cartograph__cartograph_at_range",
      "mcp__cartograph__cartograph_status"
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

The dividing line for WHERE to call a tool is **output source-volume** — does the call return full source bodies into your context?

**Source-dumping tools — `cartograph_explore`, `cartograph_context`, `cartograph_node({code: true})` — return large source sections. Don't call them directly in the main session; spawn an Explore agent** for any exploration question (e.g., "how does X work?", "explain the Y system", "where is Z implemented?") so the source lands in a disposable sub-agent context and only the distilled answer returns.

**When spawning Explore agents**, include this instruction in the prompt:

> This project has Cartograph initialized (.cartograph/ exists). Use `cartograph_explore` as your PRIMARY tool — it returns full source code sections from all relevant files in one call.
>
> **Rules:**
> 1. Follow the explore call budget in the `cartograph_explore` tool description — it scales automatically based on project size.
> 2. Do NOT re-read files that cartograph_explore already returned source code for. The source sections are complete and authoritative.
> 3. Only fall back to grep/glob/read for files listed under "Additional relevant files" if you need more detail, or if cartograph returned no results.

**The metadata-only tools return compact structured data — call them directly in the main session** (targeted lookups before making edits, not full exploration):

| Tool | Use For |
|------|----------|
| `cartograph_find` | Find symbols by name / regex / env-var / SQL ref (`by:` slice + `mode:`) |
| `cartograph_graph({direction: 'callers'\|'callees'})` | Trace call flow |
| `cartograph_graph({direction: 'impact'})` | Check what's affected before editing |
| `cartograph_node` | A single symbol's details (omit `code: true` to stay metadata-only) |
| `cartograph_at_range` | Symbols overlapping a file:line span (PR-review hunks) |
| `cartograph_biomarkers` / `cartograph_status` | Risk findings per symbol / index health |

### If `.cartograph/` does NOT exist

At the start of a session, ask the user if they'd like to initialize Cartograph:

"I notice this project doesn't have Cartograph initialized. Would you like me to run `cartograph admin init -i` to build a code knowledge graph?"
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
cartograph setup [path]            # One-shot bootstrap: admin init + install-models + doctor
cartograph doctor [path]           # Diagnose install state (--fix to auto-apply remediations)
cartograph admin init [path]       # Initialize in a project (-i / --index to also index)
cartograph admin uninit [path]     # Remove Cartograph from a project (--force to skip prompt)
cartograph admin index [path]      # Full (re)index of the project
cartograph admin sync [path]       # Incremental update
cartograph status [path]           # Show index status and statistics
cartograph find [query]            # Find symbols by name / regex / env-var / SQL ref (--by, --mode, --kind, --limit)
cartograph ask <question> [path]   # Ask a natural-language question about the codebase (needs an LLM)
cartograph digest                  # "Land in a new repo" overview — hotspots, health, entry points
cartograph files [dir]             # Show file structure (--format, --pattern, --max-depth, --json)
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
| `cartograph_find` | Find symbols by name (`exact`/`fuzzy`/`semantic`/`intent`), by regex content, or by env-var / SQL table refs (`by:` slice + `mode:`) |
| `cartograph_context` | Build relevant code context for a task |
| `cartograph_graph` | Navigate the call/dependency graph — callers, callees, blast radius, shortest path, or multi-hop BFS (`direction: 'callers'\|'callees'\|'impact'\|'path'\|'similar'`) |
| `cartograph_node` | Get details about one symbol (or up to 20 via `symbols`), optionally with source code, callers, callees, biomarkers, or tests folded inline |
| `cartograph_files` | Get indexed file structure (faster than filesystem scanning) |
| `cartograph_status` | Check index health and statistics; pass `topHotspots: N` / `topBiomarkers: N` to fold those tools' rollups into the same response (onboarding "what's interesting?" in one call) |

This is the core subset. The server exposes **30+ tools** in total — including `cartograph_biomarkers`, `cartograph_coverage`, `cartograph_hotspots`, `cartograph_dead_code`, `cartograph_deps`, `cartograph_history`, `cartograph_blame`, `cartograph_tests_for`, and `cartograph_at_range`. Call `cartograph_playbook` for the full catalog.

---

## Using with Other MCP Clients

The MCP server runs over **stdio** and works with any MCP-compatible client — not just Claude Code. The interactive installer is Claude Code-specific (it writes `~/.claude.json`), so for other clients you'll want the manual setup.

**Common steps for every client:**

```bash
# install Cartograph from source first (see Get Started) so `cartograph` is on PATH
cd your-project
cartograph admin init -i                     # initialize + index this project
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

// Initialize a fresh index, or open an existing one:
const cg = await Cartograph.init('/path/to/project');
// const cg = await Cartograph.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`),
});

// Look up symbols, then traverse the graph via the typed accessors:
const [node] = cg.queries.getNodesByFile('src/auth/login.ts');
const callers = cg.internals.traverser.getCallers(node.id);
const impact = cg.internals.traverser.getImpactRadius(node.id, 2);
const context = await cg.internals.contextBuilder.buildContext('fix login bug', {
  maxNodes: 20,
  includeCode: true,
});

await cg.sync();      // incremental update
cg.watcher.start();   // auto-sync on file changes
cg.watcher.stop();    // stop watching
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
  "maxFileSize": 5242880,
  "extractDocstrings": true,
  "trackCallSites": true
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `languages` | Languages to index (auto-detected if empty) | `[]` |
| `exclude` | Glob patterns to ignore | `["node_modules/**", ...]` |
| `frameworks` | Framework hints for better resolution | `[]` |
| `maxFileSize` | Skip files larger than this (bytes) | `5242880` (5MB) |
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
| Objective-C | `.m`, `.mm` | Full support (multi-keyword selector reconstruction, React-Native/Expo bridging) |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |
| Dart | `.dart` | Full support |
| Svelte | `.svelte` | Full support (script extraction, Svelte 5 runes, SvelteKit routes) |
| Vue | `.vue` | Full support (Single-File Components — `<script>` / `<script setup>` extraction) |
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

**"Cartograph not initialized"** — Run `cartograph admin init` in your project directory first.

**Indexing is slow** — Check that `node_modules` and other large directories are excluded. Large generated files can also dominate a run; lower `maxFileSize` in `.cartograph/config.json` to skip them.

**Vector search is slow / `⚠ no sqlite-vec`** — The storage backend is Bun's built-in `bun:sqlite`. Vector similarity (semantic/intent search and `similar`) is accelerated by the optional [`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension. Run `cartograph status` and look at the `Backend:` line:

- `Backend: bun:sqlite + sqlite-vec` — the accelerated path, nothing to do.
- `Backend: bun:sqlite ⚠ no sqlite-vec` — the extension didn't load, so vector search falls back to a slower in-memory brute-force scan. `sqlite-vec` ships prebuilt binaries for darwin/linux (x64 + arm64) and windows-x64; on other platforms the brute-force path is expected. A clean `bun install` usually re-fetches the prebuilt for your platform.

**MCP server not connecting** — Ensure the project is initialized/indexed, verify the path in your MCP config, and check that `cartograph serve --mcp` works from the command line.

**Missing symbols** — The MCP server auto-syncs on save (wait a couple seconds). Run `cartograph admin sync` manually if needed. Check that the file's language is supported and isn't excluded by config patterns.

## License

MIT

---

<div align="center">

**Made for the Claude Code community**

[Report Bug](https://github.com/adder-factory/cartograph/issues) · [Request Feature](https://github.com/adder-factory/cartograph/issues)

</div>
