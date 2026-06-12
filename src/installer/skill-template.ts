/**
 * On-demand guidance artifacts derived from the shared instructions
 * body: a `SKILL.md` (Claude Code and Codex CLI both discover
 * `skills/<name>/SKILL.md` with `name` + `description` YAML
 * frontmatter and surface it as a model-invocable `/cartograph`
 * entry) and an opencode custom command (`commands/cartograph.md`,
 * whose body is injected as a prompt when the user types
 * `/cartograph`).
 *
 * Both bodies are the verbatim `INSTRUCTIONS_BODY` so the on-demand
 * surfaces cannot drift from the always-on instructions files.
 *
 * Frontmatter descriptions are YAML plain scalars — keep them free
 * of `: ` sequences and leading indicator characters.
 */

import { INSTRUCTIONS_BODY } from './instructions-template.js';

/** Artifact basename — the slash-command name agents derive from it. */
export const SKILL_NAME = 'cartograph';

const SKILL_DESCRIPTION =
  'Explore code through the Cartograph indexed code graph instead of broad file reads — find symbols, trace callers/callees and impact, pick affected tests, and review diffs via the cartograph_* MCP tools. Use when exploring an unfamiliar codebase, tracing call flow, sizing the blast radius of a change, or when the user asks to set up Cartograph.';

/**
 * `skills/cartograph/SKILL.md` body shared by the Claude Code and
 * Codex CLI targets — both agents read the same frontmatter format.
 */
export const SKILL_TEMPLATE = `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

${INSTRUCTIONS_BODY}
`;

/**
 * opencode custom-command body. Unlike a skill, the command body is
 * injected verbatim as a user prompt, so it opens with one line
 * telling the agent what to do with the guidance that follows.
 */
export const OPENCODE_COMMAND_TEMPLATE = `---
description: Load Cartograph usage guidance — graph-first code exploration via the cartograph_* MCP tools
---

Apply the following Cartograph guidance for the rest of this session.

${INSTRUCTIONS_BODY}
`;
