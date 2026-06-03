/**
 * Agent-instructions template — the markdown body each agent target
 * writes into its conventional instructions file (CLAUDE.md /
 * AGENTS.md / cartograph.mdc / etc.).
 *
 * The body content is identical across agents because the cartograph
 * usage advice is agent-agnostic — only the destination filename and
 * any optional frontmatter (Cursor `.mdc`) varies per target.
 *
 * The legacy `claude-md-template.ts` re-exports these names for
 * backwards compatibility with downstream importers.
 */

/** Markers used by the marker-based section replacement. */
export const CARTOGRAPH_SECTION_START = '<!-- CARTOGRAPH_START -->';
export const CARTOGRAPH_SECTION_END = '<!-- CARTOGRAPH_END -->';

/**
 * The full marker-delimited block written into each agent's
 * instructions file. Includes the start/end markers so the section
 * can be detected and replaced on re-install.
 */
export const INSTRUCTIONS_TEMPLATE = `${CARTOGRAPH_SECTION_START}
## Cartograph

Cartograph builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If \`.cartograph/\` exists in the project

The dividing line for WHERE to call a tool is **output source-volume** — does the call return full source bodies into your context?

**Source-dumping tools — \`cartograph_explore\`, \`cartograph_context\`, \`cartograph_node({code: true})\` — return large source sections. Don't call them directly in the main session; spawn an Explore agent** for any exploration question (e.g., "how does X work?", "explain the Y system", "where is Z implemented?") so the source lands in a disposable sub-agent context and only the distilled answer returns.

**When spawning Explore agents**, include this instruction in the prompt:

> This project has Cartograph initialized (.cartograph/ exists). Use \`cartograph_explore\` as your PRIMARY tool — it returns full source code sections from all relevant files in one call.
>
> **Rules:**
> 1. Follow the explore call budget in the \`cartograph_explore\` tool description — it scales automatically based on project size.
> 2. Do NOT re-read files that cartograph_explore already returned source code for. The source sections are complete and authoritative.
> 3. Only fall back to grep/glob/read for files listed under "Additional relevant files" if you need more detail, or if cartograph returned no results.

**The metadata-only tools return compact structured data — call them directly in the main session** (targeted lookups before making edits, not full exploration):

For the smallest useful output, pass \`lowTokens: true\` to supported high-volume tools: \`cartograph_find\`, \`cartograph_graph\`, \`cartograph_context\`, \`cartograph_explore\`, \`cartograph_at_range\`, \`cartograph_node\`, \`cartograph_files\`, and \`cartograph_imports\`. This applies compact rows, narrower fields, lower caps, or source suppression depending on the tool. Servers launched with \`cartograph serve --mcp --low-tokens-default\` apply this by default on supported tools; pass \`lowTokens: false\` for one regular response.

If you control the MCP server launch, run \`cartograph mcp-budget\` to measure startup load. \`cartograph serve --mcp --profile core\`, \`--profile read-only\`, \`--no-write-tools\`, and repeated \`--disable-tool <name>\` reduce the advertised tool list loaded at connection time.

| Tool | Use For |
|------|---------|
| \`cartograph_find\` | Find symbols by name / regex / env-var / SQL ref (\`by:\` slice + \`mode:\`) |
| \`cartograph_graph({direction: 'callers'\\|'callees'})\` | Trace call flow |
| \`cartograph_graph({direction: 'impact'})\` | Check what's affected before editing |
| \`cartograph_node\` | A single symbol's details (omit \`code: true\` to stay metadata-only) |
| \`cartograph_at_range\` | Symbols overlapping a file:line span (PR-review hunks) |
| \`cartograph_biomarkers\` / \`cartograph_status\` | Risk findings per symbol / index health |

### If \`.cartograph/\` does NOT exist

At the start of a session, ask the user if they'd like to initialize Cartograph:

"I notice this project doesn't have Cartograph initialized. Would you like me to run \`cartograph admin init -i\` to build a code knowledge graph?"
${CARTOGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
