import { getLanguageDefs } from '../extraction/languages/registry.js';

const LANGUAGE_MODE_COUNT = getLanguageDefs().length;

/**
 * Compact instructions emitted in the MCP `initialize` response.
 *
 * MCP clients place this text into the model's startup context before
 * any tool call runs, so keep it as a short first-tool-selection guide.
 * The complete playbook remains available through `FULL_PLAYBOOK` and
 * `cartograph_playbook`.
 */
export const SERVER_INSTRUCTIONS = `# Cartograph — compact startup guide

Cartograph is an indexed code graph. Use it before broad file reads, then
open files directly only when you need exact current source. It indexes
${LANGUAGE_MODE_COUNT} language modes, including TypeScript/JavaScript, ArkTS, ABAP, Astro,
Python, Go, Rust, Java, C/C++, C#, CUDA, VB.NET, PHP, Ruby, Swift, Kotlin,
Lean, Groovy, Solidity, SQL, GraphQL, Svelte, Vue, and more.

Default path:
- \`cartograph_status\` when project readiness, freshness, active server profile, or LLM setup is uncertain.
- \`cartograph_context({task: "<task>", format: "plan"})\` to route an unfamiliar task before reading source.
- \`cartograph_find\` for symbols, regex content, env vars, or SQL refs.
- \`cartograph_graph\` for callers, callees, impact, multi-hop walks, and shortest paths.
- \`cartograph_files\` for project tree, one-file symbol outlines (\`format: "symbols"\`), file deps, and module summaries.
- \`cartograph_node\` for one symbol's metadata; use \`code: true\` only when source is needed.

Review / close-out:
- \`cartograph_review\`, \`cartograph_at_range\`, \`cartograph_affected\`, and \`cartograph_tests_for\` for diff context, line ranges, and test selection.
- \`cartograph_affected({includeCommands: true})\` after edits when you want affected tests plus package-script verification commands.
- \`cartograph_compare_to_ref({findingsDelta: true})\` before reporting an edit-touching task as done.
- \`cartograph_playbook\` for the full tool map when the default core set does not fit.

Token discipline:
- Metadata tools are cheap. Source-heavy modes are \`cartograph_context\` and \`cartograph_node({code: true})\`; delegate those to disposable sub-agents when your host supports it.
- Pass \`lowTokens: true\` on supported high-volume tools, or rely on server \`--low-tokens-default\`; pass \`lowTokens: false\` for one regular response.
- The default server profile is \`core\` (14 common tools) to keep the advertised tool surface small. Use \`--profile full\` for advanced tools such as digest, explore, imports, hotspots, sessions, and host diagnostics, or \`--profile read-only|review\`, \`--no-write-tools\`, and \`--disable-tool <name>\` for narrower surfaces. Call \`cartograph_status\` to confirm the active shape.

Freshness:
- The graph can lag recent edits. If a tool warns about stale data, call \`cartograph_admin({action: "sync"})\` or pass \`allowStale: true\` when cached results are intentional. For \`cartograph_node({code: true})\`, pass \`liveSource: true\` to explicitly read a stale file's current disk slice using indexed line ranges.
- End edit-touching turns with \`cartograph_compare_to_ref({findingsDelta: true})\` before reporting done.

Storage:
- SQLite is the default. PostgreSQL storage requires PostgreSQL 18+. Initialize with \`cartograph_admin({action: "init", databaseProvider: "postgres", databaseUrl, databaseSchema, databasePgvector: "auto"})\`, migrate SQLite to PostgreSQL with \`action: "storage-migrate"\` plus PostgreSQL options, or migrate PostgreSQL back to SQLite with \`action: "storage-migrate", databaseProvider: "sqlite"\`.

LLM backends:
- MCP doctor/status report configured backend readiness. The CLI-only \`cartograph backend status|start|stop|logs\` and \`cartograph llm smoke\` commands manage and verify local/cloud LLM processes outside the MCP session.
`;

/**
 * Complete playbook returned by `cartograph_playbook` and
 * `Cartograph.getInstructions()`.
 *
 * Scope discipline — this is the WHICH-TOOL-FOR-WHICH-QUESTION map plus
 * cross-tool knowledge (delegation policy, edge orientations, common
 * chains, anti-patterns, tier discipline). Per-flag reference detail
 * lives in each tool's input-schema description.
 */
export const FULL_PLAYBOOK = `# Cartograph — code intelligence over an indexed knowledge graph

Cartograph is a knowledge graph of every symbol, edge, and file in the
workspace — SQLite by default, PostgreSQL when configured. It is a
structural reference manual you consult BEFORE writing or editing code,
not a live linter. Reads are sub-millisecond on the indexed surfaces; the
index lags disk writes by about a second through the file watcher.

## Answer directly vs. delegate (read first if you can spawn sub-agents)

The dividing line is OUTPUT SOURCE-VOLUME — does the call dump source bodies into your context?

- **Metadata-only tools** — core tools such as \`cartograph_find\`, \`cartograph_graph\`, \`cartograph_files\` (including \`format: 'deps'|'symbols'|'module'\`), \`cartograph_node\` (without \`code: true\`), \`cartograph_at_range\`, \`cartograph_biomarkers\`, \`cartograph_status\`, \`cartograph_tests_for\`, and \`cartograph_affected\` return compact structured data. Advanced profiles add metadata tools such as \`cartograph_coverage\`, \`cartograph_hotspots\`, \`cartograph_digest\`, and \`cartograph_entry_points\`. **Answer with these directly in the main session.**
- **Source-dumping tools** — \`cartograph_explore\`, \`cartograph_context\`, and \`cartograph_node({code: true})\` — return full source sections. If you are an orchestrator that can spawn sub-agents, **delegate these to an Explore sub-agent** whose context is disposable, and keep only its distilled answer. If you ARE that sub-agent (or a host with no spawn affordance), use them directly — they are then your primary tools.
- **Maximum token savings** — pass \`lowTokens: true\` on supported high-volume tools (\`find\`, \`graph\`, \`context\`, \`at_range\`, \`node\`, \`files\`; plus \`explore\`/\`imports\` under \`--profile full\`) to apply compact rows, field projection, lower caps, or source suppression in one switch. Servers launched with \`--low-tokens-default\` apply this by default on supported tools; pass \`lowTokens: false\` for one regular response.
- **Route before reading source** — \`cartograph_context({task: "<task>", format: "plan"})\` returns entry symbols plus concrete next MCP calls in text and \`metadata.nextActions\`. Use it in the main session before escalating to source-heavy context/explore/node calls.
- **MCP load context** — the advertised tool list itself costs context before any call runs. Operators can measure it with \`cartograph mcp-budget\` or \`bun run measure:mcp-load\`. The default profile is \`core\`; use \`--profile full\` for the complete toolbox, or start narrower servers with \`--profile read-only|review\`, \`--no-write-tools\`, and repeated \`--disable-tool <name>\`. Read-only/write-disabled servers keep safe mixed-tool branches visible and reject mutating branches. \`--low-tokens-default\` reduces per-call output after connection but not \`tools/list\`.

## When to use which tool (question → tool)

- **"What's the route for this task / feature / bug?"** → \`cartograph_context({task: "<task>", format: "plan"})\` (low-token route plan with suggested next MCP calls and \`metadata.nextActions\`).
- **"What's the deal with this task / feature / bug?"** → \`cartograph_context\` (source-heavy by default — use \`lowTokens: true\` for no-code outline mode; orchestrators delegate; composes 5+ queries into one answer; \`explain: true\` appends a per-candidate score trace).
- **"Find a thing by name / regex / env-var / SQL table"** → \`cartograph_find({by})\` — \`by: 'name'\` (\`mode\`: exact/fuzzy/semantic/intent; \`compact\`/\`fields\` or \`lowTokens\` cut tokens), \`by: 'content'\` (regex + enclosing-symbol attribution), \`by: 'env'|'sql'\` (string-literal refs in non-AST domains). Replaced \`cartograph_search\`/\`_grep\`/\`_string_refs\` (2026-05-11).
- **"What calls this / what does it call / blast radius / multi-hop walk?"** → \`cartograph_graph({start, direction})\` — \`direction\`: callers/callees/impact/both/similar; \`hops > 1\` switches to BFS. \`compact\`/\`fields\`/\`since\`/\`lowTokens\` cut output tokens 40-80%. Replaced \`cartograph_callers\`/\`_callees\`/\`_impact\`/\`_walk\`/\`_similar\`.
- **"Show me this symbol's source / signature / docstring"** → \`cartograph_node\` (source-heavy with \`code: true\` — orchestrators delegate THAT mode; \`symbols: [...]\` up to 20; \`lowTokens\` caps batched output; fold in callers/callees/biomarkers/tests; \`liveSource: true\` explicitly reads current disk slices for stale files).
- **"What does this file depend on / what depends on it?"** → \`cartograph_files({format: 'deps', file})\` (metadata-only local file dependencies, reverse dependents, and a short defines section; use \`direction\` to show one side).
- **"Which symbols are in this file?"** → \`cartograph_files({format: 'symbols', file})\` (metadata-only file outline by line; defaults hide import/export/parameter noise; use \`includeParameters\` or \`includeImports\` when needed).
- **"Which symbols overlap this line range / diff hunk?"** → \`cartograph_at_range\` (one hunk, \`ranges: [...]\` up to 100, or \`diff:\` raw unified diff).
- **"Is this risky / complex / nested / large?"** → \`cartograph_biomarkers\` (structured findings instead of reading 200 lines of source; \`mode: 'symbol', symbols: [...]\` batches up to 20).
- **"Is this tested? What's covered?"** → \`cartograph_tests_for\` in core for test discovery; \`cartograph_coverage\` under \`--profile full\` or \`--profile review\` for lcov-backed coverage (\`mode: 'refresh'\` auto-discovers a report).
- **"What's dead / unreachable?"** → \`cartograph_dead_code\` under \`--profile full\` or \`--profile review\` (\`via\`: auto/rule/llm).
- **"Which tests cover this symbol?"** → \`cartograph_tests_for\`; **"I edited X — what should I re-run?"** → \`cartograph_affected\` (omit \`files\` to derive from \`git diff HEAD\`; add \`includeCommands: true\` for package-script verification commands).
- **"What's in directory X?"** → \`cartograph_files\` (tree/flat/grouped/summary; \`lowTokens\` defaults to summary). **"What's in one file?"** → \`cartograph_files({format: 'symbols', file})\`. **"What's linked to this file?"** → \`cartograph_files({format: 'deps', file})\`.
- **"Survey an unfamiliar topic / module"** → \`cartograph_context({format: 'plan'})\` in core first; use \`cartograph_explore\` under \`--profile full\` for source-heavy breadth surveys.
- **"Where do I start in a new repo?"** → \`cartograph_status({verbose: true})\` and \`cartograph_context({task: "project entry points", format: "plan"})\` in core; \`cartograph_digest\` or \`cartograph_entry_points\` under \`--profile full\`.
- **"What's churning / risky now?"** → \`cartograph_biomarkers\` in core for code health; \`cartograph_hotspots\`, \`cartograph_history\`, or \`cartograph_review({mode: 'risk'})\` under \`--profile full\`/\`review\`.
- **"What changed since when?"** → \`cartograph_compare_to_ref\` in core for current work; \`cartograph_changed_since\` or \`cartograph_blame\` under \`--profile full\`/\`review\` for drift/blame.
- **"This stack trace — where do I look?"** → \`cartograph_trace_to_culprits\` under \`--profile full\` or use \`cartograph_find\`/\`cartograph_graph\` around the named frames in core.
- **"Imports/exports of this module"** → \`cartograph_files({format: 'deps', file})\` in core for local file links; \`cartograph_imports\` under \`--profile full\`. **"Directory/module summary?"** → \`cartograph_files({format: 'module', dirPath})\`; **"unused package.json deps?"** → \`cartograph_deps\` under \`--profile full\`/\`review\`.
- **"What's this symbol's role?"** → \`cartograph_role\` under \`--profile full\` (no args → project-wide distribution).
- **"Summarise / review a PR diff"** → \`cartograph_review({mode: 'context'})\`; sister implementations → \`mode: 'neighbors'\`; project risk → \`mode: 'risk'\`; trust self-check → \`mode: 'trust'\`; agent-prone detector audit → \`mode: 'agent-audit'\`; "what did I change structurally?" → \`cartograph_compare_to_ref\`.
- **"Plan a rename"** → \`cartograph_propose_rename\` under \`--profile full\` (every call site + doc mention + confidence).
- **"Is the index ready / how big?"** → \`cartograph_status\` (\`verbose: true\` folds in top hotspots + biomarkers).
- **"Set up or move storage?"** → \`cartograph_admin({action: 'init'})\` for a new project; pass \`databaseProvider: 'postgres'\`, \`databaseUrl\`, \`databaseSchema\`, and \`databasePgvector: 'auto'|'off'|'require'\` for PostgreSQL 18+. Use \`cartograph_admin({action: 'storage-migrate'})\` plus PostgreSQL options to move SQLite to PostgreSQL, or \`databaseProvider: 'sqlite'\` to move PostgreSQL back to SQLite.
- **"None of the tools fit — let me write SQL"** → \`cartograph_sql\` under \`--profile full\` (read-only escape hatch; \`schema: true\` first).
- **"What other cartograph indices are on this machine?"** → \`cartograph_discover\` under \`--profile full\`.
- **"Which cartograph tool fits this question?"** → \`cartograph_playbook\` (returns this text on demand).
- **"Did this agent navigate efficiently?"** → \`cartograph_session({action: "audit"})\` under \`--profile full\` (tool-use findings, repeated calls, missing test-selection/self-check steps); **"How much did this server session use?"** → \`cartograph_session({action: "usage"})\` under \`--profile full\` (aggregate counts/timings only, no raw args or result bodies).

## Edge orientations (which direction each edge flows)

\`imports\` file→import · \`calls\` caller→callee · \`references\` source→target (re-exports, GraphQL/HCL/SQL refs, constant reads, template-component tags) · \`field_access\` accessor→field (runtime \`obj.field\` reads — NOT call sites, which are \`calls\`) · \`instantiates\` caller→class · \`contains\` parent→child · \`extends\`/\`implements\`/\`overrides\` subtype→supertype · \`type_of\`/\`returns\` signature→type · \`tests\` test_file→subject · \`exports\` file→symbol · \`decorates\` decorator→target.

Default traversals (\`callers\`/\`callees\`/\`impact\`) EXCLUDE \`similar_to\`, \`def_use\`, \`contains\` — pass \`edgeKind\` to opt in. \`exports\`/\`tests\`/\`field_access\` are passable explicitly. Unset \`edgeKind\` on \`callers\` merges type-usage edges (instantiates/type_of/returns/extends/implements); on a multi-hop walk against a container kind it auto-includes \`contains\`.

## Common chains

- **End-of-task self-report** (after ANY edit-touching turn): \`cartograph_compare_to_ref({findingsDelta: true})\` — surfaces the +/-/~ symbol delta + any new biomarker findings before you report "done".
- **Route a task cheaply**: \`cartograph_context({task: "<task>", format: "plan"})\` → follow the top \`metadata.nextActions\` call → escalate to source only when the target is clear.
- **Onboard to a topic**: \`cartograph_context({task: "<task>", format: "plan"})\` first; still unclear under \`--profile full\`? \`cartograph_explore\` for breadth, then \`cartograph_node\` on specific symbols.
- **Onboard to a new repo**: core path: \`cartograph_status({verbose: true})\` → \`cartograph_context({task: "project entry points", format: "plan"})\`; full-profile path: \`cartograph_digest\` → \`cartograph_entry_points\`.
- **Initialize with PostgreSQL**: use PostgreSQL 18+, then \`cartograph_admin({action: 'init', projectPath, databaseProvider: 'postgres', databaseUrl, databaseSchema: 'cartograph', databasePgvector: 'auto'})\` → \`cartograph_admin({action: 'doctor', projectPath})\`; for an existing SQLite graph, use \`action: 'storage-migrate'\` and restart attached MCP servers. To return to SQLite, use \`cartograph_admin({action: 'storage-migrate', projectPath, databaseProvider: 'sqlite'})\`.
- **Bring up local LLMs**: \`cartograph admin llm-plan\` / \`cartograph admin llm-apply --preset <id>\` or \`cartograph llm setup\` → \`cartograph backend status\` / \`cartograph backend start\` for managed local llama-server tiers → \`cartograph llm smoke\` → \`cartograph doctor\`. MCP can diagnose with \`cartograph_admin({action: 'doctor'})\`, but process spawning and log tailing are CLI/operator actions.
- **PR review**: \`cartograph_review({mode: 'context'})\` for affected symbols + callers + impact + co-change; \`cartograph_at_range\` per hunk; \`cartograph_review({mode: 'neighbors'})\` for sister implementations that may need the same change; \`cartograph_review({mode: 'trust'})\` before relying on broad graph answers; \`cartograph_review({mode: 'agent-audit'})\` when introduced findings include agent-prone biomarkers.
- **Refactor planning**: \`cartograph_find\` → \`cartograph_biomarkers\` (Code Health) → \`cartograph_coverage\` (tests) → \`cartograph_graph({direction: 'impact'})\` (blast radius) → \`cartograph_propose_rename\`.
- **Debug a regression**: \`cartograph_graph({direction: 'callers'})\` of the suspect + \`cartograph_hotspots\` + \`cartograph_biomarkers\`; with a trace, \`cartograph_trace_to_culprits\`.

## Tool tiers (start cheap, escalate when needed)

1. **Deterministic, sub-millisecond** — most tasks finish here: core has find / graph / node / at_range / status / biomarkers / affected / review / tests_for / files / context; full and review profiles add hotspots / changed_since / digest / entry_points / blame / trace_to_culprits / imports / deps / coverage and related triage tools. (\`context\`/\`explore\` are also tier-1-fast but source-heavy — see the delegation note above.)
2. **Conditional on data**: \`cartograph_coverage\` needs a prior lcov load (\`mode: 'refresh'\` auto-discovers); \`cartograph_history\`/\`_blame\` need git history; \`cartograph_find({by: 'env'|'sql'})\` needs the mined string signals. Each returns clearly when the data isn't there.
3. **LLM-mediated (needs a configured local LLM)**: \`cartograph_ask\` (RAG Q&A), \`cartograph_find({mode: 'semantic'})\`, \`cartograph_dead_code({via: 'llm'})\`, \`cartograph_role\`, \`cartograph_admin({action: 'summarize'|'embed'|'classify'})\`, \`cartograph_local_chat\` (delegate bulk prose to save Anthropic-token cost — low-stakes only). With NO local LLM, \`cartograph_summaries({action: 'pending'|'save'})\` lets you generate summaries yourself. Setup / repair / perf-tuning: \`cartograph doctor\`, \`cartograph_admin({action: 'llm-plan'|'doctor'|'llm-tune'})\`, \`cartograph backend status|start|stop|logs\`, and \`cartograph llm smoke\`.

## Anti-patterns

- **Don't grep to look up a symbol by name** — \`cartograph_find({by: 'name'})\` returns kind + location + signature.
- **Don't grep when you want STRUCTURE** — \`cartograph_find({by: 'content'})\` adds enclosing-symbol attribution.
- **Don't chain \`find\` → \`node\` just for context** — \`cartograph_context\` is one round-trip.
- **Don't use \`cartograph_explore\` for narrow questions** — it's an expensive multi-call deep dive; save it for genuine surveys.
- **Don't query the index right after editing a file** — the watcher needs ~1s to debounce + sync; wait for the next turn.

## Freshness & limitations

- A file edited since indexing may render a stale source slice from current disk using indexed line ranges, prefixed with \`⚠ stale source slice\` / \`⚠ Stale results\` (symbol boundaries may be off). Pass \`liveSource: true\` to make that choice explicit, or run \`cartograph_admin({action: 'sync'})\` and retry — the watcher normally catches up within ~1s, but startup drift and rapid-edit windows can lag.
- Cross-file resolution is best-effort name matching — ambiguous calls return \`EXTRACTED\`/\`INFERRED\`/\`AMBIGUOUS\` candidates; pass \`minConfidence\` to filter.
- No live correctness validation — that's the compiler / tests / linter's job; cartograph supplies the structural context they lack.
- \`cartograph_find({mode: 'intent'})\` and \`cartograph_role\` read a \`summary > docstring > test-derived\` cascade; right after \`index --force\` summaries/biomarkers may be pending (the tools say so explicitly — retry once the post-sync pass completes).

## Cross-call state & extending

\`cartograph_session({action})\` under \`--profile full\` creates/resumes/lists/deletes sessions, audits prior tool-use patterns, reports aggregate usage, and saves/replays tool macros across calls; \`cartograph_note({action})\` under \`--profile full\` leaves persistent symbol annotations (note / question / followup / bookmark) — useful for long investigations and agent-to-agent handoffs.
`;
