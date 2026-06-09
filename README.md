<div align="center">

# Cartograph

### Code intelligence for AI coding agents

**Index a repo once. Ask structured questions instead of rereading files.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-stdio-4f46e5.svg)](docs/MCP-USAGE.md)
[![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20PostgreSQL-0f766e.svg)](docs/STORAGE-BACKENDS.md)

<p>
  <a href="#quickstart">Quickstart</a> ·
  <a href="#why-cartograph">Why</a> ·
  <a href="#storage">Storage</a> ·
  <a href="#viewer">Viewer</a> ·
  <a href="#docs">Docs</a> ·
  <a href="#command-map">Commands</a> ·
  <a href="#supported-languages--file-formats">Languages</a>
</p>

</div>

Cartograph builds a local knowledge graph of your codebase and exposes it
through CLI commands, MCP tools, and a TypeScript API. Agents can ask for
symbols, callers, impact radius, affected tests, hotspots, code-health
findings, SQL/env references, and semantic matches without repeatedly scanning
the same files.

SQLite is the zero-config default and is capability-checked through Bun's
embedded SQLite runtime. PostgreSQL 18+ is available when you want
shared/external storage, managed backups, operational database controls, or
native pgvector search.

> Cartograph is a fork of [codegraph](https://github.com/colbymchenry/codegraph)
> by Colby Mchenry, used under the MIT License. See
> [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md).

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh

cd /path/to/your/project
cartograph quickstart .
cartograph status --verbose
```

Then connect your agent:

```bash
cartograph install
```

The installer detects and configures Claude Code, Cursor, Codex CLI, GitHub
Copilot CLI, CodeBuddy, CodeWhale, Zed, opencode, Hermes, Gemini CLI,
Antigravity, Kiro, Factory Droid, Rovo Dev, Qoder CLI, IBM Bob, Kimi Code, Pi
Agent, and Reasonix. It
writes MCP config plus agent instructions where the target supports them.

For Claude Code, `--location=local` is private to you and the current project:
the MCP entry is written under this project in `~/.claude.json`, permissions go
to `.claude/settings.local.json`, and Cartograph instructions go to
`CLAUDE.local.md` with both local files added to `.gitignore`.

If your MCP client is launched from a GUI shell that cannot find `cartograph`,
write an absolute executable path into the config:

```bash
cartograph install --command "$(command -v cartograph)"
```

To keep the graph fresh after pulls, branch switches, and rebases, install the
managed git hooks:

```bash
cartograph install-hooks --command "$(command -v cartograph)"
```

Or give this task to your coding agent:

```text
Install Cartograph for this repository. Use non-interactive commands.
If `cartograph --version` fails, run:
curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh

Then, from this repository, run:
cartograph install --yes --target=auto --location=local
cartograph status --verbose

If the agent or MCP host cannot find `cartograph` on PATH, retry install with:
cartograph install --yes --target=auto --location=local --command "$(command -v cartograph)"

Report changed files, status output, and whether I need to restart the agent.
Do not configure LLMs, download models, migrate storage, or switch to
PostgreSQL unless I ask.
```

See [Agent-Assisted Install](docs/AGENT-INSTALL.md) for the full prompt,
PowerShell command, and source-install fallback.

Source install for development:

```bash
git clone https://github.com/adder-factory/cartograph.git
cd cartograph
bun install
bun link
```

## Why Cartograph

| Problem | Cartograph gives agents |
|---|---|
| "Where is this implemented?" | Name, regex, env-var, SQL-ref, semantic, and intent search over the indexed graph |
| "What happens if I edit this?" | Callers, callees, impact radius, related symbols, co-change history, and affected tests |
| "Is this risky?" | Biomarkers, Code Health, hotspots, churn, coverage joins, dependency audit, and trust checks |
| "What should I read first?" | A route plan from `cartograph context --format plan`, then exact source only when needed |
| "What changed in my worktree?" | `cartograph compare-to-ref` structural delta and new finding summary before handoff |

Core graph features do **not** need an LLM. Optional OpenAI-compatible LLM tiers
power summaries, embeddings, semantic search, `ask`, and rerank.

## Use It From

| Surface | Start here |
|---|---|
| Human CLI | `cartograph status --verbose`, `cartograph find`, `cartograph graph`, `cartograph review` |
| MCP agent | `cartograph serve --mcp` or `cartograph install` |
| Local viewer | `cartograph viewer .` |
| Library API | `Cartograph.init('/path/to/project')` |

Cartograph's MCP server exposes all 37 registered tools. The default `core`
profile advertises the 14 most common coding-agent tools; the full 37-tool server is available with
`cartograph serve --mcp --profile full`.

## Storage

SQLite is the default and works immediately:

```bash
cartograph quickstart .
```

PostgreSQL 18+ is opt-in:

```bash
docker run --rm -d --name cartograph-postgres \
  -e POSTGRES_USER=cartograph \
  -e POSTGRES_PASSWORD=cartograph \
  -e POSTGRES_DB=cartograph \
  -p 5432:5432 \
  pgvector/pgvector:pg18

cartograph admin init -i \
  --database-provider postgres \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto

cartograph doctor .
```

Move an existing SQLite graph to PostgreSQL:

```bash
cartograph admin storage-migrate . \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto
```

Move a PostgreSQL-backed project back to local SQLite:

```bash
cartograph admin storage-migrate . \
  --database-provider sqlite
```

See [Storage Backends](docs/STORAGE-BACKENDS.md) for the PostgreSQL 18+
minimum, pgvector modes, production grants, hosted TLS notes, and migration
details.

Local storage benchmark, run 2026-06-07 with Bun 1.3.14 on `darwin arm64`:

| Backend | Init median | Write median | Read median | Total median | DB size |
|---|---:|---:|---:|---:|---:|
| SQLite | 7 ms | 70 ms | 35 ms | 112 ms | 2.12 MB |
| PostgreSQL | 102 ms | 241 ms | 470 ms | 795 ms | 7.46 MB |

Workload: 200 files, 1,600 nodes, 3,200 candidate edges, 40 read iterations,
three fresh runs per backend. SQLite remains the fastest local single-writer
default; PostgreSQL is for shared/external storage, database operations, hosted
backups, and native pgvector search.

## Viewer

```bash
cartograph viewer .
# open http://localhost:8765/
```

<p align="center">
  <img src="docs/assets/viewer.png" alt="Cartograph graph viewer showing symbol detail, source, graph tools, and code health" width="920">
</p>

The viewer is local-only and uses the same graph index as the CLI and MCP
server. Use it to inspect symbol neighborhoods, source, callers, callees,
health, coverage, and graph layout directly.

## Common Workflows

```bash
# First-time setup with LLM backend checks
cartograph quickstart .
cartograph setup .
cartograph doctor --fix .

# Find and inspect code
cartograph find "AuthService" --by name --mode fuzzy
cartograph graph AuthService --direction impact
cartograph node AuthService --include-callers --include-tests

# Review current work
cartograph review context --diff "$(git diff)"
cartograph affected --include-commands
cartograph compare-to-ref --findings-delta

# MCP server controls
cartograph serve --mcp --profile core
cartograph serve --mcp --profile full --low-tokens-default
cartograph mcp-budget
```

For agents, a good edit-session chain is:

```text
cartograph_context({task: "<task>", format: "plan"})
→ follow the suggested next action
→ cartograph_affected({includeCommands: true})
→ cartograph_compare_to_ref({findingsDelta: true})
```

Cartograph starts from Git-visible files, then applies local indexing policy.
A root `.ignore` file can re-include useful gitignored source with negated
patterns such as `!customer/` without changing repository semantics; explicit
Cartograph `exclude` entries and `.cartographignore` marker directories still
win.

## Docs

| Need | Go to |
|---|---|
| Pasteable task for a coding agent to install Cartograph | [docs/AGENT-INSTALL.md](docs/AGENT-INSTALL.md) |
| PostgreSQL, pgvector, migration, storage benchmark | [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) |
| CLI command reference | [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md) |
| Graph export artifact formats | [docs/GRAPH-EXPORT-FORMATS.md](docs/GRAPH-EXPORT-FORMATS.md) |
| MCP setup, profiles, load budget, client snippets | [docs/MCP-USAGE.md](docs/MCP-USAGE.md) |
| Configuration and advanced options | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Language/framework matrix | [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Add a language | [docs/ADDING-A-LANGUAGE.md](docs/ADDING-A-LANGUAGE.md) |

## Command Map

<details>
<summary><strong>Show top-level CLI commands</strong></summary>

| Command | Use for |
|---|---|
| `cartograph admin` | Project lifecycle, indexing, setup, doctor, storage migration, and LLM admin actions |
| `cartograph affected` | Find test files affected by changed source files |
| `cartograph ask` | Ask natural-language questions about the codebase with an LLM |
| `cartograph at-range` | Resolve file:line ranges or diff hunks to indexed symbols |
| `cartograph backend` | Manage configured local llama-server processes |
| `cartograph biomarkers` | Static-analysis findings and Code Health |
| `cartograph blame` | Symbol-level git blame |
| `cartograph changed-since` | File drift since index time or timestamp |
| `cartograph compare-to-ref` | End-of-task structural and finding delta |
| `cartograph completions` | Shell completion scripts for Bash, Zsh, Fish, and PowerShell |
| `cartograph context` | Task-specific context and route plans |
| `cartograph coverage` | Per-symbol coverage joined to graph data |
| `cartograph dead-code` | Potentially-dead symbol candidates |
| `cartograph dependency-coverage` | Resolved and unresolved graph dependency coverage by language and edge kind |
| `cartograph deps` | package.json dependency audit |
| `cartograph digest` | "Land in a new repo" overview |
| `cartograph discover` | Find other `.cartograph` indexes |
| `cartograph entry-points` | Routes, CLI commands, MCP tools, and public exports |
| `cartograph explore` | Deep topic exploration |
| `cartograph export` | Graph artifact export: JSON, DOT, Mermaid, Cytoscape |
| `cartograph file-deps` | Local file dependencies and dependents for one indexed file |
| `cartograph file-symbols` | Symbols in one indexed file |
| `cartograph files` | Indexed file tree and summaries |
| `cartograph find` | Symbol, content, env-var, and SQL-ref search |
| `cartograph graph` | Call/dependency graph traversal |
| `cartograph guide` | Compact first-use and daily-workflow guide |
| `cartograph history` | Symbol-level co-change |
| `cartograph host-diagnostics` | MCP host/profile visibility and installer target diagnostics |
| `cartograph hotspots` | Churn x centrality triage |
| `cartograph imports` | Import statement graph data |
| `cartograph install` | Configure MCP server entries for supported agents |
| `cartograph install-hooks` | Install managed git hooks for quiet background sync |
| `cartograph llm` | Local/cloud LLM provider setup and smoke checks |
| `cartograph local-chat` | Delegate bulk prose to a local LLM |
| `cartograph mcp-budget` | Measure MCP startup payload size |
| `cartograph module` | Directory/module summary |
| `cartograph node` | Symbol details, optionally with source and related data |
| `cartograph note` | Persistent annotations/bookmarks |
| `cartograph playbook` | Tool-selection playbook |
| `cartograph propose-rename` | Rename plan with call sites and mentions |
| `cartograph quickstart` | Initialize, build the structural index, and run doctor |
| `cartograph review` | Diff, neighbor, risk, audit, and trust review helpers |
| `cartograph role` | Symbol role classification |
| `cartograph serve` | Start the MCP server |
| `cartograph session` | Session state, macros, and audits |
| `cartograph setup` | LLM bootstrap: init, models, doctor |
| `cartograph similar` | Embedding-cosine peers of a symbol |
| `cartograph sql` | Read-only SQL escape hatch |
| `cartograph status` | Index status and feature readiness |
| `cartograph summaries` | Pull/save agent-written summaries |
| `cartograph sync-if-dirty` | Hook compatibility sync that no-ops on clean git trees |
| `cartograph tests-for` | Tests covering a symbol or files |
| `cartograph trace-to-culprits` | Stack trace to likely fix sites |
| `cartograph upgrade` | Check for a newer Cartograph release and print update steps |
| `cartograph viewer` | Local graph viewer |

</details>

## Supported Languages & File Formats

Cartograph supports **73 language modes**. Framework-aware and derived signals
are listed separately so the core language matrix stays readable.

<details>
<summary><strong>Show language matrix</strong></summary>

| Language | Extensions / scope |
|---|---|
| ABAP | `.abap` |
| TypeScript / TSX | `.ts`, `.mts`, `.cts`, `.tsx` |
| JavaScript / JSX / ArkTS | `.js`, `.mjs`, `.cjs`, `.xsjs`, `.xsjslib`, `.jsx`, `.ets` |
| Python | `.py`, `.pyw` |
| Go | `.go` |
| Rust | `.rs` |
| Java / Kotlin / Scala / Groovy | `.java`, `.kt`, `.kts`, `.scala`, `.sc`, `.groovy`, `.gradle` |
| C / C++ / C# / CUDA | `.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx`, `.cs`, `.cu`, `.cuh` |
| VB.NET / Visual Basic 6 | `.vb`, `.bas`, `.frm`, `.ctl`, `.dob`, `.dsr`, `.pag`, `.vbp`, VB6 `.cls` by content |
| Clojure / ClojureScript | `.clj`, `.cljs`, `.cljc`, `.edn`, `.bb` |
| Common Lisp | `.lisp`, `.lsp`, `.l`, `.cl`, `.asd`, `.ros` |
| Objective-C / Swift | `.m`, `.mm`, `.swift` |
| PHP / Ruby | `.php`, `.module`, `.install`, `.theme`, `.inc`, `.rb`, `.rake` |
| Salesforce | `.cls`, `.trigger`, plus Aura/Visualforce markup extensions in Salesforce source paths |
| BG3 modding data | `.lsx`, `.lsf`, `.lsfx`, `.lsefx`, `.tbl`, `.stats`, `.mei`, `.lsj`, `.ann`, `.anc`, `.khn`, `.div`, BG3 Stats/Generated `.txt`, BG3 Story goal `.txt`, BG3 Localization XML |
| Dart / ReScript / R / Lua / Luau / Elixir / Lean | `.dart`, `.res`, `.resi`, `.r`, `.R`, `.lua`, `.luau`, `.ex`, `.exs`, `.lean` |
| F# / Haskell / Julia / OCaml | `.fs`, `.fsx`, `.hs`, `.jl`, `.ml`, `.mli` |
| HTML / CSS / ERB / EJS | `.html`, `.htm`, `.css`, `.erb`, `.ejs`, `.eta`, `.etlua` |
| Astro / Svelte / Vue / Liquid | `.astro`, `.svelte`, `.vue`, `.liquid` |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr`, `.dfm`, `.fmx` |
| Bash / Zsh / Fish / PowerShell | `.sh`, `.bash`, `.zsh`, `.zshrc`, `.fish`, `.ps1`, `.psm1`, `.psd1` |
| GraphQL / GLSL / HLSL / Nix / Solidity / SQL / HCL / Prisma / Properties / XML / YAML | `.graphql`, `.gql`, `.glsl`, `.vert`, `.frag`, `.comp`, `.geom`, `.tesc`, `.tese`, `.hlsl`, `.hlsli`, `.fx`, `.fxh`, `.nix`, `.sol`, `.sql`, `.tf`, `.tfvars`, `.hcl`, `.tofu`, `.prisma`, `.properties`, `.xml`, `.yaml`, `.yml` |
| JSON / Jupyter / JSDoc / Regex / Verilog | `.json`, `.ipynb`, `.jsdoc`, `.regex`, `.regexp`, `.v`, `.vh`, `.sv`, `.svh` |

</details>

## Framework-Aware Signals

| Ecosystem | Signals |
|---|---|
| JavaScript / TypeScript | Angular routes, Express routes, Hono routes and mounted sub-routers, Bun.serve routes, React components, Vue/Nuxt aliases/routes, SvelteKit routes, Commander CLI commands |
| Python | Django, Flask, FastAPI route/controller patterns, and NeuG graph resource landmarks |
| PHP | Laravel facades/routes, Drupal routes/services/hooks/plugins/service tags, Symfony routes/controllers, and CodeIgniter 3 routes/controller/model/library conventions |
| Ruby | Rails routes and controller conventions |
| JVM | Spring route/config references including `@Value` and `@ConditionalOnProperty`, Play routes, and MyBatis Java/XML bindings including `SqlSessionTemplate` statement ids |
| Salesforce | Apex classes/methods/triggers, LWC component bundles and Apex imports, Aura controllers/actions, Visualforce routes/actions |
| Go / Rust / C# / Dart / Swift | Common route and entry-point patterns, Flutter routes, Cargo workspace crate aliases |
| Apple / React Native | SwiftUI, UIKit, Vapor, Swift-Objective-C bridging, React Native legacy/TurboModules, Expo Modules, Fabric/Paper view components |

Static resolution also handles language-specific ownership and call shapes,
including Python package-member imports, Go receiver methods split across files,
C# primary constructors, PHP include/require imports, and return-type-backed
chained calls.

## Embedded DSLs & Derived Signals

| Signal | What gets added |
|---|---|
| Zod / Pydantic | Schema structs, fields, and enum members |
| GraphQL SDL | Types, fields, enums, interfaces, and references |
| Prisma / SQL | Models, tables, views, functions, triggers, schemas, and table references |
| Config / env refs | Env-var, config-key, feature-flag, and build-context reference edges |
| Dynamic dispatch | Bounded TS/JS dispatch-table call edges with inferred confidence |
| Tests / coverage / history | Test edges, lcov joins, churn, issue history, co-change, and hotspot signals |

See [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md) for the full matrix.

## What Cartograph Is Not

| Expectation | Reality |
|---|---|
| Hosted SaaS | Cartograph is local-first; the graph database is local SQLite by default or your configured PostgreSQL instance |
| Test replacement | It finds affected tests and risks; your test suite remains the source of truth |
| LLM-only reviewer | Review tools are deterministic graph queries first; LLM features are optional |
| Cloud dependency | Core indexing and graph tools work offline after dependencies are installed |

## License

MIT

<div align="center">

[Report Bug](https://github.com/adder-factory/cartograph/issues) ·
[Request Feature](https://github.com/adder-factory/cartograph/issues)

</div>
