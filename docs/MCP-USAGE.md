# MCP Usage

Cartograph runs as a stdio MCP server:

```sh
cartograph serve --mcp
```

For most users, the installer is easier:

```sh
cartograph install
```

It can configure Claude Code, Cursor, Codex CLI, GitHub Copilot CLI,
CodeBuddy, CodeWhale, Zed, opencode, Hermes, Gemini CLI, Antigravity, Kiro,
Factory Droid, Rovo Dev, Qoder CLI, IBM Bob, Kimi Code, Pi Agent, and
Reasonix.

## Agent-Assisted Install

For a coding agent working inside the user's project, prefer the
non-interactive local install:

```sh
cartograph install --yes --target=auto --location=local
cartograph status --verbose
```

If the agent process cannot resolve `cartograph` from PATH, pass the absolute
executable path that should be written into MCP configs:

```sh
cartograph install --yes --target=auto --location=local --command "$(command -v cartograph)"
```

If the current agent has no supported local config path, retry global wiring:

```sh
cartograph install --yes --target=auto --location=global
```

`--yes` makes the command suitable for agents and CI. In local mode it
initializes `.cartograph/`, indexes the repository, and defers optional LLM
setup instead of opening the interactive provider wizard.

Generated local project config and instruction files are added to `.gitignore`
because they can contain absolute checkout paths and personal agent rules. Local
MCP server args include `--project-path <this-project>` where the client config
is project-scoped.

The full copy-paste task for users is in
[Agent-Assisted Install](AGENT-INSTALL.md).

## Server Profiles

```sh
cartograph serve --mcp --profile core       # default
cartograph serve --mcp --profile full       # all registered tools
cartograph serve --mcp --profile read-only
cartograph serve --mcp --profile review
cartograph serve --mcp --no-write-tools
cartograph serve --mcp --low-tokens-default
cartograph serve --mcp --daemon --project-path /absolute/path/to/project
```

Profiles filter the advertised tool list. `core` is the 14-tool common
coding-agent surface. `full` exposes every registered tool. `review` focuses
diff/risk/test workflows. `read-only` advertises read-capable tools and blocks
mutating branches of mixed tools.

Shared daemon mode uses a per-project Unix socket on POSIX and a per-project
named pipe on Windows. Startup retires stale lock/socket state and treats an
active Windows named pipe as an already-running daemon instead of racing it.

The server advertises MCP `tools`, `resources`, and `prompts` capabilities.
Cartograph's public surface is still tool-first; `resources/list`,
`resources/templates/list`, and `prompts/list` return empty lists so clients
that probe the modern MCP resource/prompt endpoints do not fail the session.

## Suggested Agent Workflow

Start with metadata tools before reading source:

```text
cartograph_status
cartograph_context({task: "<task>", format: "plan"})
cartograph_find
cartograph_graph
cartograph_node without code
```

After edits:

```text
cartograph_affected({includeCommands: true})
cartograph_compare_to_ref({findingsDelta: true})
```

Use `cartograph_playbook` for the full tool-selection guide. Start with
`--profile full` when you need advanced tools such as digest, explore, imports,
hotspots, sessions, or `cartograph_host`.
For `cartograph_context`, send `task` as the canonical prompt parameter;
`query` is accepted as an alias for MCP clients that already model search-like
calls around a `query` field.
For file-focused lookups, use `cartograph_files`: `format: "symbols"` for a
one-file outline, `format: "deps"` for local dependencies/dependents, and
`format: "module"` for directory summaries.

## Load Budget

MCP clients request `tools/list` at startup, and many clients put that schema
into the model context. Measure the current shape with:

```sh
cartograph mcp-budget
bun run check:mcp-load
```

On this repository's default `core` profile, the current measured startup load
is:

| Payload | Chars | Est. tokens |
|---|---:|---:|
| tools/list, 14 tools | 33,739 | ~8,435 |
| initialize instructions | 3,346 | ~837 |
| combined startup load | 37,085 | ~9,272 |
| full playbook, on demand | 16,282 | ~4,071 |

The full 34-tool profile is 60,422 `tools/list` chars and 63,768 combined
startup chars. `--profile full --no-write-tools` and `--profile read-only`
reduce the full list to 33 tools, 55,471 `tools/list` chars, and 58,817
combined startup chars. The review profile advertises 23 tools, 45,729
`tools/list` chars, and 49,075 combined startup chars.

`lowTokens: true` and `--low-tokens-default` reduce per-call output, not the
advertised startup schema.

## Client Snippets

### Generic stdio

| Field | Value |
|---|---|
| Command | `cartograph` |
| Args | `["serve", "--mcp"]` |
| Transport | `stdio` |

Use `cartograph install --command /absolute/path/to/cartograph` to write a
custom command value into supported client configs.

The snippets below show minimal manual configs. `cartograph install
--location=local` writes the same target-specific shapes but pins project-scoped
server args with `--project-path /absolute/path/to/project` and gitignores
generated project-local files.

If the client does not send `rootUri`, pass the project explicitly:

```sh
cartograph serve --mcp --project-path /absolute/path/to/project
```

### Claude Code

Use the installer for the current Claude Code scopes:

```sh
cartograph install --yes --target=claude --location=local
```

Local Claude MCP scope is private per project and is stored in `~/.claude.json`
under the current project path:

```json
{
  "projects": {
    "/absolute/path/to/project": {
      "mcpServers": {
        "cartograph": {
          "type": "stdio",
          "command": "cartograph",
          "args": ["serve", "--mcp", "--project-path", "/absolute/path/to/project"]
        }
      }
    }
  }
}
```

The same local install writes Claude permissions to
`.claude/settings.local.json`, writes Cartograph instructions to
`CLAUDE.local.md`, and adds both local project files to `.gitignore`.

For team-shared Claude MCP config, use a project `.mcp.json` with the standard
`mcpServers` shape.

### Codex CLI

Use the installer for Codex's user-global or trusted project-local config:

```sh
cartograph install --yes --target=codex --location=local
```

Local Codex installs write `.codex/config.toml` in the current project and pin
Cartograph to that project:

```toml
[mcp_servers.cartograph]
command = "cartograph"
args = ["serve", "--mcp", "--project-path", "/absolute/path/to/project"]
```

Use `--location=global` only when one global Cartograph default is acceptable,
or keep passing `projectPath` explicitly in MCP calls. The installer adds the
generated `.codex/config.toml` to `.gitignore` because it contains an absolute
local path.

### Cursor

`~/.cursor/mcp.json` or `.cursor/mcp.json`:

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

### GitHub Copilot CLI

`~/.copilot/mcp-config.json`, `.mcp.json`, or `.github/mcp.json`:

```json
{
  "mcpServers": {
    "cartograph": {
      "type": "stdio",
      "command": "cartograph",
      "args": ["serve", "--mcp"],
      "tools": ["*"]
    }
  }
}
```

The installer honors `COPILOT_HOME` for the global Copilot configuration
directory. You can also add the same server interactively with Copilot CLI's
`/mcp add` flow and then run `/mcp reload`.

### CodeBuddy

`~/.codebuddy/.mcp.json`, `~/.codebuddy/mcp.json`, or project `.mcp.json`:

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

The installer uses a JSONC-preserving writer for CodeBuddy so comments and
trailing commas in existing config files are kept.

### CodeWhale

`~/.codewhale/mcp.json` or `.codewhale/mcp.json`:

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

### Zed

`~/.config/zed/settings.json` or `.zed/settings.json`:

```json
{
  "context_servers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

### opencode

`opencode.json` or `~/.config/opencode/opencode.json`:

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

### Factory Droid

`~/.factory/mcp.json` or `.factory/mcp.json`:

```json
{
  "mcpServers": {
    "cartograph": {
      "type": "stdio",
      "command": "cartograph",
      "args": ["serve", "--mcp"],
      "disabled": false
    }
  }
}
```

### Rovo Dev

`~/.rovodev/mcp.json` or `.rovodev/mcp.json`:

```json
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"],
      "transport": "stdio"
    }
  }
}
```

For local Rovo profiles, point `mcp.mcpConfigPath` at `.rovodev/mcp.json` if
the profile does not already load that file.

### Qoder CLI

`~/.qoder/settings.json` or `.qoder/settings.local.json`:

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

### IBM Bob

`~/.bob/mcp_settings.json` or `.bob/mcp.json`:

```json
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"],
      "disabled": false
    }
  }
}
```

Enable MCP servers in Bob settings if this is the first MCP server for the
workspace.

### Kimi Code

`~/.kimi-code/mcp.json`, `$KIMI_CODE_HOME/mcp.json`, or
`.kimi-code/mcp.json`:

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

### Pi Agent

`~/.pi/agent/mcp.json`, `$PI_CODING_AGENT_DIR/mcp.json`, or `.pi/mcp.json`:

```json
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"],
      "transport": "stdio"
    }
  }
}
```

Pi support is adapter-backed: install the Pi MCP adapter or extension package
before expecting Pi Agent to consume the config file.

### Reasonix

`~/.reasonix/config.json`:

```json
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"],
      "disabled": false
    }
  }
}
```

Reasonix stores MCP servers in its global config; project `.reasonix/`
directories are for project-scoped skills, memory, hooks, and settings.

### LangChain

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
```

Cartograph does not speak SSE/HTTP directly. Clients that only support SSE need
a stdio bridge.
