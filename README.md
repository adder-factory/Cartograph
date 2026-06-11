<div align="center">

# Cartograph

**Local-first code intelligence for AI coding agents.**

Index a repository once, then query it for symbols, callers, impact radius,
affected tests, and code-health signals instead of repeatedly re-reading
source. Cartograph runs as a CLI, an MCP server, and a TypeScript library.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black.svg)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-stdio-4f46e5.svg)](docs/MCP-USAGE.md)
[![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20PostgreSQL-0f766e.svg)](docs/STORAGE-BACKENDS.md)

[Why](#why-cartograph) ·
[Install](#install) ·
[Quickstart](#quickstart) ·
[Capabilities](#capabilities) ·
[Usage](#usage) ·
[Languages &amp; storage](#languages-and-storage) ·
[Docs](#documentation)

</div>

---

## Why Cartograph

Coding agents spend most of their budget re-reading files to answer structural
questions: *Where is this implemented? What calls it? What breaks if I change
it? Which tests cover it?* Repeatedly scanning source is slow, expensive in
tokens, and easy to get wrong on large codebases.

Cartograph builds a local knowledge graph of your repository and exposes it
through precise queries. An agent (or a developer) asks for exactly the symbol,
neighborhood, impact set, or finding it needs, and gets a compact, structured
answer without loading whole files into context.

| The agent asks | Cartograph answers with |
|---|---|
| "Where is this implemented?" | Name, regex, env-var, and SQL-reference search, plus optional semantic and intent search over the indexed graph |
| "What breaks if I edit this?" | Callers, callees, impact radius, related symbols, co-change history, and affected tests |
| "Is this risky?" | Biomarkers and Code Health findings, hotspots, churn, coverage joins, dependency audit, and trust checks |
| "What should I read first?" | A route plan from `cartograph context --format plan`, then exact source only where it is needed |
| "What did my change touch?" | A structural and finding delta from `cartograph compare-to-ref` before handoff |

The core graph features require no LLM and work offline once dependencies are
installed. Optional OpenAI-compatible LLM tiers add summaries, embeddings,
semantic search, `ask`, and rerank.

## Install

> No prebuilt GitHub release is published yet, so install from source. Once a
> release exists, the `install.sh` / `install.ps1` scripts below will fetch a
> prebuilt binary and verify it against the release `SHA256SUMS` (set
> `CARTOGRAPH_SKIP_CHECKSUM=1` to bypass verification).

### From source (current path)

Requires [Bun](https://bun.sh) `>= 1.3`.

```bash
git clone https://github.com/adder-factory/cartograph.git
cd cartograph
bun install
bun link
```

`bun link` puts `cartograph` on your `PATH`. Verify with `cartograph --version`.

To update a source install later:

```bash
cartograph upgrade          # check how far behind the checkout is
cartograph upgrade --apply  # fast-forward + bun install, with safety guards
```

`cartograph update` is an alias. The update is refused (nothing is touched) if
the working tree is dirty, the branch has diverged from its upstream, or HEAD
is detached. Restart any running MCP sessions afterwards so they load the new
code.

### Prebuilt (after a release is published)

```bash
# Verifies the download against the release SHA256SUMS before installing.
curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh
```

A PowerShell equivalent (`install.ps1`) and an agent-driven install flow are
documented in [Agent-Assisted Install](docs/AGENT-INSTALL.md).

## Quickstart

One command from inside your project does the whole setup — MCP config for
detected agents, `.cartograph/` init, the structural index, and managed git
hooks:

```bash
cd /path/to/your/project
cartograph install --yes --location=local
```

Prefer prompts? Run plain `cartograph` (or `cartograph install`) for the
interactive version of the same flow — it offers to link the binary onto
`PATH`, lets you pick agents and location, and asks before touching git hooks.

SQLite is the zero-config default; nothing else is required to start querying:

```bash
cartograph status --verbose
cartograph find "SymbolName" --mode fuzzy
```

To index a project *without* touching any agent config, use
`cartograph index .` (init + index + readiness check only; previously named
`quickstart`, which still works as an alias).

### What the installer writes

- **MCP server config plus agent instructions** for detected agents, where the
  target supports them. Supported targets: Claude Code, Cursor, Codex CLI,
  GitHub Copilot CLI, CodeBuddy, CodeWhale, Zed, opencode, Hermes, Gemini CLI,
  Antigravity, Kiro, Factory Droid, Rovo Dev, Qoder CLI, IBM Bob, Kimi Code,
  Pi Agent, and Reasonix. Pick explicitly with `--target=<ids>`.
- **Managed git hooks** (`post-merge`, `post-checkout`, `post-rewrite`) so
  pulls, branch switches, and rebases keep the index fresh. Skip with
  `--no-hooks`; manage later with `cartograph install-hooks [--remove]`.
- If `cartograph` is not resolvable on `PATH`, the installer pins an absolute
  path into the generated config automatically; override with
  `--command <path>`.
- With `--location=global` the MCP config is written once for all projects and
  the project-local steps (init, index, hooks) are skipped — run
  `cartograph index .` per project instead.

Configuration written for `--location=local` (project-scoped MCP entries and
instruction files) is added to `.gitignore`, because it can contain absolute
checkout paths and personal agent rules. To remove Cartograph's MCP entries
from installed agents later:

```bash
cartograph uninstall            # global entries (default)
cartograph uninstall --location local
```

See [Agent-Assisted Install](docs/AGENT-INSTALL.md) for a pasteable prompt that
lets a coding agent perform the whole setup, plus the PowerShell variant.

## Capabilities

| Area | What you get |
|---|---|
| **Search** | Symbol-by-name (exact, fuzzy, semantic, intent), regex content search, env-var reads, and SQL table references |
| **Graph navigation** | Callers, callees, impact radius, multi-hop walks, shortest paths, and embedding-similarity peers |
| **Impact & tests** | Affected tests for changed files, per-symbol coverage joins, and package-script verification commands |
| **Code health** | Biomarkers and Code Health findings, churn × centrality hotspots, dead-code candidates, and a dependency audit |
| **History** | Symbol-level git blame and co-change signals |
| **Review** | Diff-driven context, semantic neighbors, composed risk triage, and a readiness self-check |
| **Context** | Task-scoped route plans that suggest the next query before any source is read |
| **Entry points** | Routes, CLI commands, MCP tools, and public exports across many frameworks |
| **Export & view** | Graph export (JSON, DOT, Mermaid, Cytoscape) and a local-only graph viewer |

Cartograph indexes **73 language modes** and recognizes framework-aware signals
(routes, controllers, components, schemas, DI bindings) across the JavaScript /
TypeScript, Python, PHP, Ruby, JVM, Go, Rust, C#, Dart, Swift, and Salesforce
ecosystems. Embedded DSLs such as Zod, Pydantic, GraphQL SDL, Prisma, and SQL
contribute structural nodes and reference edges. See the
[support matrix](docs/SUPPORT-MATRIX.md) for the full list.

## Usage

### From an MCP agent

Run the server directly, or let `cartograph install` wire it into your client:

```bash
cartograph serve --mcp                       # default 'core' profile
cartograph serve --mcp --profile full        # full tool surface
```

Cartograph registers **34 MCP tools** (all prefixed `cartograph_`). The default
`core` profile advertises the 14 most common coding-agent tools to keep the
loaded tool surface small; `full` exposes everything, and `read-only` and
`review` are scoped subsets. A typical edit-session chain is:

```text
cartograph_context({ task: "<task>", format: "plan" })
  → follow the suggested next action
  → cartograph_affected({ includeCommands: true })
  → cartograph_compare_to_ref({ findingsDelta: true })
```

See [MCP usage](docs/MCP-USAGE.md) for profiles, the startup load budget,
low-token mode, and client config snippets.

### From the CLI

```bash
# Find and inspect code
cartograph find "AuthService" --by name --mode fuzzy
cartograph graph AuthService --direction impact
cartograph node AuthService --include-callers --include-tests

# Inspect files and structure
cartograph files . --format tree
cartograph files --format symbols --file src/auth/service.ts

# Review current work
cartograph review context --diff "$(git diff)"
cartograph affected --include-commands
cartograph compare-to-ref --findings-delta
```

The CLI mirrors the MCP tool surface command-for-command. See the
[CLI reference](docs/CLI-REFERENCE.md) for every command and flag.

### From TypeScript

```ts
import Cartograph from '@adder-factory/cartograph';

const cg = await Cartograph.open('/path/to/project');
// ... query the graph, then cg.close()
```

The MCP server is also importable from the `@adder-factory/cartograph/mcp`
subpath.

### Local viewer

```bash
cartograph viewer .
# open http://localhost:8765/
```

<p align="center">
  <img src="docs/assets/viewer.png" alt="Cartograph graph viewer showing symbol detail, source, graph tools, and code health" width="900">
</p>

The viewer is local-only and reads the same graph index as the CLI and MCP
server. Use it to inspect symbol neighborhoods, source, callers, callees,
health, coverage, and graph layout.

## Languages and storage

### Languages

Cartograph supports **73 language modes**, including TypeScript / JavaScript /
ArkTS, Python, Go, Rust, Java / Kotlin / Scala / Groovy, C / C++ / C# / CUDA,
Swift / Objective-C, PHP, Ruby, Salesforce Apex, and dozens more, alongside
framework-aware signals and embedded-DSL extraction. The
[support matrix](docs/SUPPORT-MATRIX.md) is generated from the registry and is
the authoritative list.

### Storage

SQLite is the default and works immediately with no configuration. It is the
fastest local single-writer backend and is capability-checked through Bun's
embedded SQLite runtime.

PostgreSQL 18+ is opt-in for shared or external storage, managed backups,
operational database controls, and native pgvector search:

```bash
cartograph admin init -i \
  --database-provider postgres \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto
```

Existing graphs migrate between backends with `cartograph admin storage-migrate`.
See [Storage Backends](docs/STORAGE-BACKENDS.md) for the PostgreSQL minimum,
pgvector modes, production grants, hosted TLS notes, migration details, and a
local benchmark.

## What Cartograph is not

| Expectation | Reality |
|---|---|
| Hosted SaaS | Local-first; the graph lives in local SQLite by default, or in your own PostgreSQL instance |
| Test replacement | It surfaces affected tests and risks; your test suite remains the source of truth |
| LLM-only reviewer | Review and risk tools are deterministic graph queries first; LLM features are optional |
| Cloud dependency | Core indexing and graph queries run offline once dependencies are installed |

## Documentation

| Topic | Document |
|---|---|
| Agent-assisted install (pasteable prompt, PowerShell) | [docs/AGENT-INSTALL.md](docs/AGENT-INSTALL.md) |
| CLI command reference | [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md) |
| MCP setup, profiles, load budget, client snippets | [docs/MCP-USAGE.md](docs/MCP-USAGE.md) |
| PostgreSQL, pgvector, migration, storage benchmark | [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md) |
| Configuration and advanced options | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Language and framework support matrix | [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md) |
| Graph export artifact formats | [docs/GRAPH-EXPORT-FORMATS.md](docs/GRAPH-EXPORT-FORMATS.md) |
| Adding a language | [docs/ADDING-A-LANGUAGE.md](docs/ADDING-A-LANGUAGE.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |

## Acknowledgements

Cartograph is a fork of [codegraph](https://github.com/colbymchenry/codegraph)
by Colby Mchenry, used under the MIT License. It has diverged substantially from
upstream but derives from that codebase, and we gratefully acknowledge it as the
foundation. Cartograph also stands on tree-sitter grammars and many other
open-source libraries. See [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md) for full
credits.

## License

[MIT](https://opensource.org/licenses/MIT)

<div align="center">

[Report a bug](https://github.com/adder-factory/cartograph/issues) ·
[Request a feature](https://github.com/adder-factory/cartograph/issues)

</div>
