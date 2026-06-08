# Agent-Assisted Install

Give this task to a coding agent from the repository you want Cartograph to
index:

```text
Install Cartograph for this repository and wire it into my current coding
agent. Use non-interactive commands where possible.

1. If `cartograph --version` fails, install Cartograph:
   curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh
   If that release install is unavailable, use the source fallback:
   git clone https://github.com/adder-factory/cartograph.git /tmp/cartograph
   cd /tmp/cartograph && bun install && bun link

2. From my project repository, run:
   cartograph install --yes --target=auto --location=local
   cartograph status --verbose

3. If no local agent config file was created, retry global agent wiring:
   cartograph install --yes --target=auto --location=global

4. Report the exact files created or changed, whether `.cartograph/` was
   initialized, the `cartograph status --verbose` result, and whether I need to
   restart the coding agent.

Do not download LLM models, configure cloud credentials, migrate storage, or
switch to PostgreSQL unless I ask for those separately.
```

For PowerShell users, replace the install command in step 1 with:

```powershell
iwr https://raw.githubusercontent.com/adder-factory/cartograph/main/install.ps1 -useb | iex
```

The local install command initializes `.cartograph/`, writes supported local MCP
configuration, indexes the repository, and skips the interactive LLM wizard in
`--yes` mode. Core search, graph, impact, review, status, and affected-test
commands work without an LLM backend.

Supported installer targets include Claude Code, Cursor, Codex CLI, GitHub
Copilot CLI, opencode, Hermes, Gemini CLI, Antigravity, Kiro, Factory Droid,
Rovo Dev, and Qoder CLI.

Optional follow-up tasks:

```text
Configure Cartograph's optional LLM features for semantic search and ask.
Start with `cartograph llm setup`, then run `cartograph doctor .`.
```

```text
Move Cartograph storage from SQLite to PostgreSQL for this repository.
Use PostgreSQL 18+, follow `docs/STORAGE-BACKENDS.md`, preserve the existing
graph with `cartograph admin storage-migrate`, and run `cartograph doctor .`
afterward.
```
