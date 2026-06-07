# MCP Usage

Cartograph runs as a stdio MCP server:

```sh
cartograph serve --mcp
```

For most users, the installer is easier:

```sh
cartograph install
```

It can configure Claude Code, Cursor, Codex CLI, opencode, Hermes, Gemini CLI,
Antigravity, and Kiro.

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

## Suggested Agent Workflow

Start with metadata tools before reading source:

```text
cartograph_status
cartograph_context({format: "plan"})
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
important closeout steps.

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
| tools/list, 22 tools | 44,900 | ~11,225 |
| initialize instructions | 2,539 | ~635 |
| combined startup load | 47,439 | ~11,860 |
| full playbook, on demand | 13,435 | ~3,359 |

The full 36-tool profile is 63,964 `tools/list` chars and 66,503 combined
startup chars. `--profile full --no-write-tools` and `--profile read-only`
reduce the full list to 35 tools and 61,047 combined startup chars.

`lowTokens: true` and `--low-tokens-default` reduce per-call output, not the
advertised startup schema.

## Client Snippets

### Generic stdio

| Field | Value |
|---|---|
| Command | `cartograph` |
| Args | `["serve", "--mcp"]` |
| Transport | `stdio` |

If the client does not send `rootUri`, pass the project explicitly:

```sh
cartograph serve --mcp --project-path /absolute/path/to/project
```

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
