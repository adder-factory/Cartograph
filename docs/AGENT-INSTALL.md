# Agent-Assisted Install

Give this task to a coding agent from the repository you want Cartograph to
index:

```text
Install Cartograph for this repository and wire it into my current coding
agent. Use non-interactive commands.

1. If `cartograph --version` fails, install Cartograph from source
   (requires Bun >= 1.3):
   git clone https://github.com/adder-factory/cartograph.git /tmp/cartograph
   cd /tmp/cartograph && bun install && bun link

2. From my project repository, run the one-command setup, then verify:
   cartograph install --yes --location=local
   cartograph status --verbose

3. If no local agent config file was created, retry global agent wiring:
   cartograph install --yes --location=global

4. Report the exact files created or changed (including git hooks), whether
   `.cartograph/` was initialized, the `cartograph status --verbose` result,
   and whether I need to restart the coding agent.

Do not download LLM models, configure cloud credentials, migrate storage, or
switch to PostgreSQL unless I ask for those separately.
```

Prebuilt releases are published for macOS (arm64, x64), Linux (x64, arm64),
and Windows (x64); step 1 can instead use the standalone installer
(`install.sh`, or `install.ps1` for PowerShell):

```sh
curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh
```

```powershell
iwr https://raw.githubusercontent.com/adder-factory/cartograph/main/install.ps1 -useb | iex
```

The one-command local setup initializes `.cartograph/`, writes supported local
MCP configuration, indexes the repository, installs the managed git hooks, and
skips the interactive LLM wizard in `--yes` mode. Core search, graph, impact,
review, status, and affected-test commands work without an LLM backend. If
`cartograph` is not resolvable on PATH, the installer pins an absolute path
into the generated config automatically; override with `--command <path>`.

The managed `post-merge`, `post-checkout`, and `post-rewrite` hook blocks make
pulls, branch switches, and rebases trigger a quiet background sync. Existing
hook content is preserved. Skip them at install time with `--no-hooks`, and
add or remove them later with `cartograph install-hooks [--remove]`.

For local installs, generated project config and instruction files are added to
`.gitignore` because local MCP entries can contain absolute checkout paths and
personal agent rules. Local MCP server args include
`--project-path <this-project>` where the client config is project-scoped. This
avoids a global MCP entry defaulting to whichever project was installed last.
Claude Code is a special case: the private project-scoped MCP entry is stored in
`~/.claude.json`, while permissions and instructions stay in the worktree as
gitignored files.

Supported installer targets include Claude Code, Cursor, Codex CLI, GitHub
Copilot CLI, CodeBuddy, CodeWhale, Zed, opencode, Hermes, Gemini CLI,
Antigravity, Kiro, Factory Droid, Rovo Dev, Qoder CLI, IBM Bob, Kimi Code, Pi
Agent, and Reasonix.

Optional follow-up tasks:

```text
Configure Cartograph's optional LLM features for semantic search and ask.
Start with `cartograph llm setup`, run `cartograph backend start .` when the
chosen preset uses managed local llama-server tiers, then run
`cartograph llm smoke .` and `cartograph doctor .`.
```

```text
Move Cartograph storage from SQLite to PostgreSQL for this repository.
Use PostgreSQL 18+, follow `docs/STORAGE-BACKENDS.md`, preserve the existing
graph with `cartograph admin storage-migrate`, and run `cartograph doctor .`
afterward.
```

```text
Move Cartograph storage from PostgreSQL back to SQLite for this repository.
Use `cartograph admin storage-migrate --database-provider sqlite`, run
`cartograph doctor .` afterward, and restart any MCP server attached to the old
database.
```
