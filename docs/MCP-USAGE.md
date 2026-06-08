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
CodeWhale, Zed, opencode, Hermes, Gemini CLI, Antigravity, Kiro, Factory
Droid, Rovo Dev, Qoder CLI, IBM Bob, Kimi Code, and Reasonix.

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

Profiles filter the advertised tool list. `core` is the common coding-agent
surface. `full` exposes every registered tool. `review` focuses diff/risk/test
workflows. `read-only` advertises read-capable tools and blocks mutating
branches of mixed tools.

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

Use `cartograph_playbook` for the full tool-selection guide. Use
`cartograph_session({action: "audit"})` to inspect whether an agent skipped
important closeout steps, and `cartograph_session({action: "usage"})` for
aggregate session/tool counts without raw request or response bodies.
For `cartograph_context`, send `task` as the canonical prompt parameter;
`query` is accepted as an alias for MCP clients that already model search-like
calls around a `query` field.

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
| tools/list, 24 tools | 44,195 | ~11,049 |
| initialize instructions | 2,835 | ~709 |
| combined startup load | 47,030 | ~11,758 |
| full playbook, on demand | 14,236 | ~3,559 |

The full 38-tool profile is 61,977 `tools/list` chars and 64,812 combined
startup chars. `--profile full --no-write-tools` and `--profile read-only`
reduce the full list to 37 tools, 56,946 `tools/list` chars, and 59,781
combined startup chars.

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
          "args": ["serve", "--mcp"]
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
