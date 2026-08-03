# Configuration

Cartograph keeps non-secret project policy in `.cartograph/config.json`.
Database URLs and API credentials belong in the process environment or private
managed state, never in a committed file.

The file is optional. A representative v2 configuration is:

```json
{
  "version": 2,
  "languages": ["typescript", "python", "rust"],
  "include": ["src/**", "tests/**"],
  "exclude": ["vendor/**", "generated/**"],
  "maxFileSize": 5242880,
  "maxGenerationBytes": 1073741824,
  "extractDocstrings": true,
  "trackCallSites": true,
  "enableCentrality": true,
  "enableBetweenness": true,
  "enableChurn": true,
  "enableCoChange": true,
  "enableBiomarkers": true,
  "enableIssueHistory": true,
  "enableConfigRefs": true,
  "enableSqlRefs": true,
  "enableBuildContextRefs": true,
  "enableStringImports": true,
  "duplicateCodePartialClones": false,
  "duplicateCodeAllowlist": ["generated/**"]
}
```

## Source and evidence policy

| Option | Meaning | Default |
| --- | --- | --- |
| `version` | Config contract version. Use `2` for new files | `2` when Cartograph writes a file |
| `languages` | Stable language-mode allowlist; empty means every supported mode | all |
| `include` | Project-relative glob allowlist; omitted means all admitted paths | omitted |
| `exclude` | Additional project-relative glob exclusions | `[]` plus built-in exclusions |
| `maxFileSize` | Per-source byte ceiling, 1 byte through 32 MiB | runtime default |
| `maxGenerationBytes` | Final canonical-generation byte ceiling, 1 byte through 8 GiB | 1 GiB |
| `extractDocstrings` | Retain safe structural documentation evidence | `true` |
| `trackCallSites` | Retain reference-site provenance | `true` |
| `indexSubmodules` | Include Git submodules | `true` |
| `indexEmbeddedRepos` | Include detected nested repositories; disabled when submodules are disabled | `true` |
| `enableCentrality` | Compute native PageRank | `true` |
| `enableBetweenness` | Compute bounded sampled Brandes betweenness | `true` |
| `enableChurn` | Derive bounded Git churn evidence | `true` |
| `enableCoChange` | Derive bounded Git co-change evidence | `true` |
| `enableBiomarkers` | Compute deterministic code-health findings | `true` |
| `enableIssueHistory` | Derive issue-tagged symbol history | `true` |
| `enableConfigRefs` | Add configuration/environment-reference evidence | `true` |
| `enableSqlRefs` | Add embedded SQL relation evidence | `true` |
| `enableBuildContextRefs` | Add build/container context evidence | `true` |
| `enableStringImports` | Add bounded import-shaped literal evidence | `true` |
| `duplicateCodePartialClones` | Enable the wider Type-3 partial-clone band | `false` |
| `duplicateCodeAllowlist` | Globs exempt from duplicate-code findings | `[]` |

V1 config files remain readable. For a legacy `version` below 2, Cartograph
adds `.pyi` and `.toml` admission when an old explicit include list would
otherwise hide v2's additive coverage. New configuration should use version 2.

Discovery follows Git-compatible ignore behavior, then applies explicit
Cartograph policy. A `.cartographignore` marker excludes its directory tree; at
the project root it opts the entire checkout out of indexing.

`maxGenerationBytes` bounds the reduced canonical generation that can be
published; it is not a total-process-memory limit. Resolve and canonical
validation admit separately measured unordered/temporary working sets of up to
four times that value. Raising the option is therefore an explicit high-memory
choice and should follow a typed `*_generation_capacity_exceeded` result plus
observed host headroom. The default remains 1 GiB.

PostgreSQL publication is independently bounded: each canonical table starts a
new COPY statement at 100,000 rows or before an encoded batch would exceed 64
MiB; one independently bounded row is indivisible. The complete generation
remains in one atomic transaction. This prevents one
large COPY statement from consuming the whole database deadline, but it does
not turn native parse/resolve/reduce into an unbounded spill-to-database
pipeline. Extremely large corpora can still require an explicit generation
ceiling or can fail safely before publication.

Dependency audit allowlists are read from `dependenciesAllowlist` or
`analysis.dependenciesAllowlist`. Architecture-layer policy uses `layers` and
`layerExceptions`; see command help and emitted validation errors for its
bounded schema.

## PostgreSQL settings

Cartograph v2 is PostgreSQL-only. Storage selection is not a project-config
option: use environment/private managed state.

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_project'
export CARTOGRAPH_DATABASE_MAX_CONNECTIONS=8
export CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS=5000
export CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS=120000
export CARTOGRAPH_DATABASE_REQUIRE_SSL=true
```

| Variable | Bound/default |
| --- | --- |
| `CARTOGRAPH_DATABASE_URL` | Required for an external database; `postgres`/`postgresql` URL with a host |
| `CARTOGRAPH_DATABASE_SCHEMA` | ASCII identifier, 1..63 bytes; default `cartograph` |
| `CARTOGRAPH_DATABASE_MAX_CONNECTIONS` | 1..64; default 8 |
| `CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS` | 1..120000; default 5000 |
| `CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS` | 1..600000; default 120000 |
| `CARTOGRAPH_DATABASE_REQUIRE_SSL` | `true`/`false` or `1`/`0`; default false |

When `cartograph db start` owns the database, the runtime resolves the private
project-local credential instead. There is no SQLite provider, importer,
migration target, or pgvector-off mode.

## Optional LLM tiers

The project `llm` object controls optional embeddings, reranking, generated
summaries/roles, ask, and local chat. Structural graph and retrieval features
remain usable without it.

```json
{
  "version": 2,
  "llm": {
    "enabled": true,
    "summarize": true,
    "summarizeEagerLimit": 600,
    "minBodyLines": 4,
    "minBodyLinesByKind": { "route": 1 },
    "embeddingLlm": {
      "provider": "openai-compat",
      "endpoint": "http://127.0.0.1:8080",
      "model": "jina-embeddings-v2-base-code"
    },
    "summarizeLlm": {
      "provider": "openai-compat",
      "endpoint": "http://127.0.0.1:8081",
      "model": "/absolute/path/to/chat.gguf",
      "concurrency": 1,
      "summaryBatchSize": 4,
      "llamaServerArgs": ["-c", "8192"]
    },
    "askLlm": {
      "provider": "anthropic-api",
      "endpoint": "https://api.anthropic.com",
      "model": "claude-sonnet-4-6",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "rerankerLlm": {
      "provider": "openai-compat",
      "endpoint": "http://127.0.0.1:8083",
      "model": "local-cross-encoder"
    }
  }
}
```

Tier keys retained from v1.1.33 are `embeddingLlm`, `summarizeLlm`, `localLlm`,
`askLlm`, `classifyLlm`, and `rerankerLlm`. Ask/local/classify may fall back to
the summarize tier. Chat providers are:

- `openai-compat` for local or cloud OpenAI-compatible HTTP;
- `anthropic-api` for the Anthropic Messages API;
- `claude-bridge` for the bounded local Claude CLI bridge.

Embedding and reranker tiers require OpenAI-compatible HTTP. Optional tier
fields include bounded `timeoutMs`, `concurrency`, `summaryBatchSize`,
`apiKeyEnv`, `claudeBin`, `llamaServerArgs`, and `externallyManaged` where
applicable. Inline legacy keys are read for compatibility but environment
lookup is the safe configuration.

A low-load deployment may configure only `embeddingLlm` and `rerankerLlm` and
set `summarizeLlm`, `askLlm`, `localLlm`, and `classifyLlm` to `null`.
`cartograph llm smoke` tests configured tiers and reports those absent
generative tiers as explicit skips. Reranking applies only to bounded semantic
Top-K candidates before reciprocal-rank fusion. The source-bearing candidate
text sent to that operator-configured endpoint is capped and is never included
in Cartograph's serialized search response; reranker failure retains cosine
ordering and reports the exact outcome.

Audit and migrate legacy inline tier keys without printing them:

```sh
cartograph llm migrate-credentials . --json
cartograph llm migrate-credentials . \
  --tier-env summarize=MY_CHAT_API_KEY \
  --apply \
  --confirm migrate-inline-credentials \
  --json
```

The dry run defaults OpenAI-compatible tiers to `OPENAI_API_KEY` and Anthropic
tiers to `ANTHROPIC_API_KEY`; `--tier-env tier=NAME` overrides one tier. Apply
removes an inline value only when the current process proves the named variable
contains the exact same value. The atomic report contains tier, variable name,
and status, never credential material.

Use the native planner/wizard instead of hand-writing provider details:

```sh
cartograph llm setup
cartograph llm smoke .
cartograph doctor .
```

Planner presets cover detected endpoints, llama.cpp, Ollama, MLX/custom
OpenAI-compatible endpoints, cloud OpenAI, hybrid Claude bridge, hybrid
Anthropic API, and skip. `cartograph backend` manages only explicitly
configured local `llama-server` processes; external providers remain
operator-owned.

The MCP process reloads LLM configuration at the next LLM operation. Agent-host
MCP registration or binary replacement still requires a host restart.
