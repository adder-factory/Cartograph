# Configuration

Cartograph stores project config in `.cartograph/config.json`.

Most projects can omit the file or keep it small; defaults are intentionally
conservative.

```json
{
  "version": 1,
  "rootDir": ".",
  "languages": ["typescript", "javascript"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/build/**"],
  "frameworks": [],
  "maxFileSize": 5242880
}
```

## Common Options

| Option | Description | Default |
|---|---|---|
| `rootDir` | Root directory relative to project path | `"."` |
| `include` | Glob patterns to index | language defaults |
| `languages` | Languages to index; empty means auto-detect | `[]` |
| `exclude` | Glob patterns to ignore | dependency/build/cache/generated defaults |
| `maxFileSize` | Skip files larger than this many bytes | `5242880` |
| `frameworks` | Framework hints for extraction/resolution | `[]` |
| `extractDocstrings` | Extract docstrings from code | `true` |
| `trackCallSites` | Track call site locations | `true` |
| `enableCentrality` | Compute graph centrality | `true` |
| `enableBetweenness` | Compute betweenness centrality | `false` |
| `enableChurn` | Mine git churn signals | `true` |
| `enableIssueHistory` | Mine issue-history signals | `true` |
| `enableCoChange` | Mine co-change signals | `true` |
| `enableConfigRefs` | Add config/env reference edges | `true` |
| `enableSqlRefs` | Add SQL reference edges | `true` |
| `enableBuildContextRefs` | Add Docker/build context refs | `true` |
| `enableStringImports` | Add string import edges | `true` |
| `indexSubmodules` | Recurse into git submodules | `true` |
| `indexEmbeddedRepos` | Recurse into standalone nested git repos hidden by the parent repo ignore rules when submodule indexing is enabled | `true` |
| `dependenciesAllowlist` | Packages never flagged by dependency audit | `[]` |

`indexEmbeddedRepos` covers nested repositories that are not registered git
submodules, for example a checked-out SDK under a parent-ignored `vendor/` or
`embedded/` directory. Set it to `false` when those nested repositories should
stay outside the graph. `indexSubmodules: false` disables both submodule and
embedded-repository recursion.

Cartograph also reads a root `.ignore` file as a local indexing override after
Git discovery. Non-negated patterns hide matching paths from Cartograph, while
negated patterns such as `!customer/` re-include local source that `.gitignore`
hides. This does not change Git semantics and does not override explicit
Cartograph `exclude` patterns or `.cartographignore` marker directories.

`maxFileSize` can also be set from the CLI. `cartograph admin init
--max-file-size <size>` writes it into the initial config; `admin index`,
`admin sync`, `admin embed-only`, and `sync-if-dirty` accept the same flag as a
transient one-run override. Values can be bytes or binary suffixes such as
`512kb` or `10mb`. The default remains 5 MiB, and explicit config or CLI
values are capped at 10 MiB.

## Storage Options

SQLite is default. PostgreSQL options live under `database` and require
PostgreSQL 18 or newer:

| Option | Description | Default |
|---|---|---|
| `database.provider` | `sqlite` or `postgres` | `sqlite` |
| `database.url` | PostgreSQL 18+ connection URL | unset |
| `database.schema` | PostgreSQL schema | `public` |
| `database.pgvector` | `auto`, `off`, or `require` | `auto` |
| `database.maxConnections` | PostgreSQL pool cap | `1` |
| `database.connectionTimeoutSeconds` | PostgreSQL connection timeout | `30` |
| `database.queryTimeoutMs` | Adapter wait timeout and `statement_timeout` | `120000` |
| `database.idleTimeoutSeconds` | Close idle PostgreSQL connections | Bun default |
| `database.maxLifetimeSeconds` | Recycle PostgreSQL connections | Bun default |
| `database.ssl` | Force TLS on/off; prefer URL `sslmode=` for verification | URL/default |

Environment fallbacks:

```sh
CARTOGRAPH_DATABASE_PROVIDER=postgres
CARTOGRAPH_DATABASE_URL=postgres://user:pass@host:5432/cartograph
DATABASE_URL=postgres://user:pass@host:5432/cartograph
CARTOGRAPH_DATABASE_SCHEMA=cartograph
CARTOGRAPH_DATABASE_PGVECTOR=auto
CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS=120000
CARTOGRAPH_DATABASE_CONNECTION_TIMEOUT_SECONDS=30
CARTOGRAPH_DATABASE_MAX_CONNECTIONS=1
CARTOGRAPH_DATABASE_SSL=true
```

For a local SQLite project, omit the `database` block or set
`database.provider` to `sqlite`. To copy an existing PostgreSQL-backed graph
back to SQLite and remove the PostgreSQL config, run
`cartograph admin storage-migrate --database-provider sqlite`.

See [Storage Backends](STORAGE-BACKENDS.md) for setup and migration.

## LLM Options

LLM tiers use OpenAI-compatible HTTP providers. The core graph does not require
LLMs.

Use the wizard:

```sh
cartograph llm setup
cartograph doctor --fix .
cartograph backend start .
cartograph llm smoke .
```

Common backend choices are Ollama, llama-cpp `llama-server`, Apple MLX, LM
Studio, vLLM, LocalAI, and cloud OpenAI-compatible providers.

For cloud, two presets are first-class: `cloud-openai` (reads `OPENAI_API_KEY`
from the environment) and `cloud-openrouter` (one key in front of hundreds of
hosted models; set `OPENROUTER_API_KEY`, get one at <https://openrouter.ai/keys>).
Apply either with `cartograph admin llm-apply --preset <id>` or pick it in the
wizard. The OpenRouter preset configures the chat tiers only — pair a local or
cloud embedding provider if you want semantic search:

```json
{
  "llm": {
    "summarizeLlm": {
      "provider": "openai-compat",
      "endpoint": "https://openrouter.ai/api",
      "model": "google/gemini-2.5-flash-lite"
    },
    "askLlm": {
      "provider": "openai-compat",
      "endpoint": "https://openrouter.ai/api",
      "model": "anthropic/claude-haiku-4.5"
    },
    "embeddingLlm": {
      "provider": "openai-compat",
      "endpoint": "http://localhost:8080",
      "model": "jina-embeddings-v2-base-code"
    }
  }
}
```

Any other OpenAI-compatible cloud (together.ai, fireworks.ai, groq, ...) works
through the generic `cloud-openai-compat` template with an explicit `apiKey`.
