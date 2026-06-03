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
open files directly only when you need exact current source.

Start with:
- \`cartograph_status\` for index health, freshness, active server profile, and LLM readiness.
- \`cartograph_find\` for symbols, regex content, env vars, or SQL refs.
- \`cartograph_graph\` for callers, callees, impact, multi-hop walks, and shortest paths.
- \`cartograph_node\` for one symbol's metadata; use \`code: true\` only when source is needed.
- \`cartograph_context\` for task-shaped implementation context; it may return source.
- \`cartograph_review\`, \`cartograph_at_range\`, \`cartograph_compare_to_ref\`, \`cartograph_affected\`, and \`cartograph_tests_for\` for review, diff, final self-check, and test selection.
- \`cartograph_playbook\` for the full tool map, edge directions, common chains, and anti-patterns.

Token discipline:
- Metadata tools are cheap. Source-heavy modes are \`cartograph_context\`, \`cartograph_explore\`, and \`cartograph_node({code: true})\`; delegate those to disposable sub-agents when your host supports it.
- Pass \`lowTokens: true\` on supported high-volume tools, or rely on server \`--low-tokens-default\`; pass \`lowTokens: false\` for one regular response.
- Server launch flags such as \`--profile core|read-only|review\`, \`--no-write-tools\`, and \`--disable-tool <name>\` shrink the advertised tool surface; call \`cartograph_status\` to confirm them.

Freshness:
- The graph can lag recent edits. If a tool warns about stale data, call \`cartograph_admin({action: "sync"})\` or pass \`allowStale: true\` when cached results are intentional.
- End edit-touching turns with \`cartograph_compare_to_ref({findingsDelta: true})\` before reporting done.
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

Cartograph is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — a structural reference manual you consult BEFORE writing
or editing code, not a live linter. Reads are sub-millisecond; the index
lags disk writes by about a second through the file watcher.

## Answer directly vs. delegate (read first if you can spawn sub-agents)

The dividing line is OUTPUT SOURCE-VOLUME — does the call dump source bodies into your context?

- **Metadata-only tools** — \`cartograph_find\`, \`cartograph_graph\`, \`cartograph_node\` (without \`code: true\`), \`cartograph_at_range\`, \`cartograph_biomarkers\`, \`cartograph_role\`, \`cartograph_status\`, \`cartograph_coverage\`, \`cartograph_tests_for\`, \`cartograph_affected\`, \`cartograph_hotspots\` — return compact structured data. **Answer with these directly in the main session.**
- **Source-dumping tools** — \`cartograph_explore\`, \`cartograph_context\`, and \`cartograph_node({code: true})\` — return full source sections. If you are an orchestrator that can spawn sub-agents, **delegate these to an Explore sub-agent** whose context is disposable, and keep only its distilled answer. If you ARE that sub-agent (or a host with no spawn affordance), use them directly — they are then your primary tools.
- **Maximum token savings** — pass \`lowTokens: true\` on supported high-volume tools (\`find\`, \`graph\`, \`context\`, \`explore\`, \`at_range\`, \`node\`, \`files\`, \`imports\`) to apply compact rows, field projection, lower caps, or source suppression in one switch. Servers launched with \`--low-tokens-default\` apply this by default on supported tools; pass \`lowTokens: false\` for one regular response.
- **MCP load context** — the advertised tool list itself costs context before any call runs. Operators can start focused servers with \`--profile core|read-only|review\`, \`--no-write-tools\`, and repeated \`--disable-tool <name>\`; \`--low-tokens-default\` reduces per-call output after connection but not \`tools/list\`.

## When to use which tool (question → tool)

- **"What's the deal with this task / feature / bug?"** → \`cartograph_context\` (source-heavy by default — use \`lowTokens: true\` for no-code outline mode; orchestrators delegate; composes 5+ queries into one answer; \`explain: true\` appends a per-candidate score trace).
- **"Find a thing by name / regex / env-var / SQL table"** → \`cartograph_find({by})\` — \`by: 'name'\` (\`mode\`: exact/fuzzy/semantic/intent; \`compact\`/\`fields\` or \`lowTokens\` cut tokens), \`by: 'content'\` (regex + enclosing-symbol attribution), \`by: 'env'|'sql'\` (string-literal refs in non-AST domains). Replaced \`cartograph_search\`/\`_grep\`/\`_string_refs\` (2026-05-11).
- **"What calls this / what does it call / blast radius / multi-hop walk?"** → \`cartograph_graph({start, direction})\` — \`direction\`: callers/callees/impact/both/similar; \`hops > 1\` switches to BFS. \`compact\`/\`fields\`/\`since\`/\`lowTokens\` cut output tokens 40-80%. Replaced \`cartograph_callers\`/\`_callees\`/\`_impact\`/\`_walk\`/\`_similar\`.
- **"Show me this symbol's source / signature / docstring"** → \`cartograph_node\` (source-heavy with \`code: true\` — orchestrators delegate THAT mode; \`symbols: [...]\` up to 20; \`lowTokens\` caps batched output; fold in callers/callees/biomarkers/tests).
- **"Which symbols overlap this line range / diff hunk?"** → \`cartograph_at_range\` (one hunk, \`ranges: [...]\` up to 100, or \`diff:\` raw unified diff).
- **"Is this risky / complex / nested / large?"** → \`cartograph_biomarkers\` (structured findings instead of reading 200 lines of source; \`mode: 'symbol', symbols: [...]\` batches up to 20).
- **"Is this tested? What's covered?"** → \`cartograph_coverage\` (\`mode: 'refresh'\` auto-discovers an lcov report).
- **"What's dead / unreachable?"** → \`cartograph_dead_code\` (\`via\`: auto/rule/llm).
- **"Which tests cover this symbol?"** → \`cartograph_tests_for\`; **"I edited X — what should I re-run?"** → \`cartograph_affected\` (omit \`files\` to derive from \`git diff HEAD\`).
- **"What's in directory X?"** → \`cartograph_files\` (tree/flat/grouped/summary; \`lowTokens\` defaults to summary).
- **"Survey an unfamiliar topic / module"** → \`cartograph_explore\` (source-heavy by default — use \`lowTokens: true\` for summary-only file headers; orchestrators delegate; genuine "I'm new here" surveys only).
- **"Where do I start in a new repo?"** → \`cartograph_digest\` (composite overview) or \`cartograph_entry_points\` (routes / cli / mcp_tools / public_exports).
- **"What's churning / risky now?"** → \`cartograph_hotspots\` (churn × centrality), \`cartograph_history\` (cochange), \`cartograph_review({mode: 'risk'})\` (composed triage).
- **"What changed since when?"** → \`cartograph_changed_since\` (content drift) or \`cartograph_blame\` (per-symbol git blame).
- **"This stack trace — where do I look?"** → \`cartograph_trace_to_culprits\` (parse trace → ranked fix sites).
- **"Imports/exports of this module"** → \`cartograph_imports\`, \`cartograph_module\`; **"unused package.json deps?"** → \`cartograph_deps\`.
- **"What's this symbol's role?"** → \`cartograph_role\` (no args → project-wide distribution).
- **"Summarise / review a PR diff"** → \`cartograph_review({mode: 'context'})\`; sister implementations → \`mode: 'neighbors'\`; project risk → \`mode: 'risk'\`; trust self-check → \`mode: 'trust'\`; agent-prone detector audit → \`mode: 'agent-audit'\`; "what did I change structurally?" → \`cartograph_compare_to_ref\`.
- **"Plan a rename"** → \`cartograph_propose_rename\` (every call site + doc mention + confidence).
- **"Is the index ready / how big?"** → \`cartograph_status\` (\`verbose: true\` folds in top hotspots + biomarkers).
- **"None of the tools fit — let me write SQL"** → \`cartograph_sql\` (read-only escape hatch; \`schema: true\` first).
- **"What other cartograph indices are on this machine?"** → \`cartograph_discover\`.
- **"Which cartograph tool fits this question?"** → \`cartograph_playbook\` (returns this text on demand).

## Edge orientations (which direction each edge flows)

\`imports\` file→import · \`calls\` caller→callee · \`references\` source→target (re-exports, GraphQL/HCL/SQL refs, constant reads, template-component tags) · \`field_access\` accessor→field (runtime \`obj.field\` reads — NOT call sites, which are \`calls\`) · \`instantiates\` caller→class · \`contains\` parent→child · \`extends\`/\`implements\`/\`overrides\` subtype→supertype · \`type_of\`/\`returns\` signature→type · \`tests\` test_file→subject · \`exports\` file→symbol · \`decorates\` decorator→target.

Default traversals (\`callers\`/\`callees\`/\`impact\`) EXCLUDE \`similar_to\`, \`def_use\`, \`contains\` — pass \`edgeKind\` to opt in. \`exports\`/\`tests\`/\`field_access\` are passable explicitly. Unset \`edgeKind\` on \`callers\` merges type-usage edges (instantiates/type_of/returns/extends/implements); on a multi-hop walk against a container kind it auto-includes \`contains\`.

## Common chains

- **End-of-task self-report** (after ANY edit-touching turn): \`cartograph_compare_to_ref({findingsDelta: true})\` — surfaces the +/-/~ symbol delta + any new biomarker findings before you report "done".
- **Onboard to a topic**: \`cartograph_context\` first; still unclear? \`cartograph_explore\` for breadth, then \`cartograph_node\` on specific symbols.
- **Onboard to a new repo**: \`cartograph_digest\` → \`cartograph_entry_points\`.
- **PR review**: \`cartograph_review({mode: 'context'})\` for affected symbols + callers + impact + co-change; \`cartograph_at_range\` per hunk; \`cartograph_review({mode: 'neighbors'})\` for sister implementations that may need the same change; \`cartograph_review({mode: 'trust'})\` before relying on broad graph answers; \`cartograph_review({mode: 'agent-audit'})\` when introduced findings include agent-prone biomarkers.
- **Refactor planning**: \`cartograph_find\` → \`cartograph_biomarkers\` (Code Health) → \`cartograph_coverage\` (tests) → \`cartograph_graph({direction: 'impact'})\` (blast radius) → \`cartograph_propose_rename\`.
- **Debug a regression**: \`cartograph_graph({direction: 'callers'})\` of the suspect + \`cartograph_hotspots\` + \`cartograph_biomarkers\`; with a trace, \`cartograph_trace_to_culprits\`.

## Tool tiers (start cheap, escalate when needed)

1. **Deterministic, sub-millisecond** — most tasks finish here: find / graph / node / at_range / status / biomarkers / hotspots / changed_since / affected / digest / entry_points / blame / review / tests_for / trace_to_culprits / module / imports / deps. (\`context\`/\`explore\` are also tier-1-fast but source-heavy — see the delegation note above.)
2. **Conditional on data**: \`cartograph_coverage\` needs a prior lcov load (\`mode: 'refresh'\` auto-discovers); \`cartograph_history\`/\`_blame\` need git history; \`cartograph_find({by: 'env'|'sql'})\` needs the mined string signals. Each returns clearly when the data isn't there.
3. **LLM-mediated (needs a configured local LLM)**: \`cartograph_ask\` (RAG Q&A), \`cartograph_find({mode: 'semantic'})\`, \`cartograph_dead_code({via: 'llm'})\`, \`cartograph_role\`, \`cartograph_admin({action: 'summarize'|'embed'|'classify'})\`, \`cartograph_local_chat\` (delegate bulk prose to save Anthropic-token cost — low-stakes only). With NO local LLM, \`cartograph_summaries({action: 'pending'|'save'})\` lets you generate summaries yourself. Setup / repair / perf-tuning: \`cartograph doctor\` and \`cartograph_admin({action: 'llm-plan'|'doctor'})\`; env tuning knobs are documented in CLAUDE.md.

## Anti-patterns

- **Don't grep to look up a symbol by name** — \`cartograph_find({by: 'name'})\` returns kind + location + signature.
- **Don't grep when you want STRUCTURE** — \`cartograph_find({by: 'content'})\` adds enclosing-symbol attribution.
- **Don't chain \`find\` → \`node\` just for context** — \`cartograph_context\` is one round-trip.
- **Don't use \`cartograph_explore\` for narrow questions** — it's an expensive multi-call deep dive; save it for genuine surveys.
- **Don't query the index right after editing a file** — the watcher needs ~1s to debounce + sync; wait for the next turn.

## Freshness & limitations

- A file edited since indexing still renders its indexed-snapshot body, prefixed with \`⚠ source from indexed snapshot\` / \`⚠ Stale results\` (line numbers may be off). Run \`cartograph_admin({action: 'sync'})\` and retry — the watcher normally catches up within ~1s, but startup drift and rapid-edit windows can lag.
- Cross-file resolution is best-effort name matching — ambiguous calls return \`EXTRACTED\`/\`INFERRED\`/\`AMBIGUOUS\` candidates; pass \`minConfidence\` to filter.
- No live correctness validation — that's the compiler / tests / linter's job; cartograph supplies the structural context they lack.
- \`cartograph_find({mode: 'intent'})\` and \`cartograph_role\` read a \`summary > docstring > test-derived\` cascade; right after \`index --force\` summaries/biomarkers may be pending (the tools say so explicitly — retry once the post-sync pass completes).

## Cross-call state & extending

\`cartograph_session({action})\` creates/resumes sessions and saves/replays tool macros across calls; \`cartograph_note({action})\` leaves persistent symbol annotations (note / question / followup / bookmark) — useful for long investigations and agent-to-agent handoffs. Adding a tool / detector / resolver to cartograph itself? The structural patterns are documented in \`CLAUDE.md\`.
`;
