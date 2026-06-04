/**
 * `cartograph_session({action})` — agent session state + macros (#13).
 *
 * Eight actions on the consolidated family pattern from #7:
 *
 *   - `create  ({label})`            → mint a labelled session row
 *   - `resume  ({id?, label?})`      → render compact summary of prior calls
 *   - `list    ({limit?})`           → recent sessions, newest first
 *   - `delete  ({id?, label?})`      → drop a session row + its tool calls
 *   - `macro_save  ({name, steps})`  → store a recipe of {tool,args} steps
 *   - `macro_run   ({name, args?})`  → replay each step in order
 *   - `macro_list  ({})`             → show saved recipes
 *   - `macro_delete({name})`         → drop a recipe
 *
 * Storage lives in two tables added by migration 030:
 *   - `mcp_sessions.label` (extra column on the 028 trace table)
 *   - `mcp_macros (name, steps_json, created_ts, last_run_ts)`
 *
 * Session IDs created here are *separate from* the trace logger's
 * per-process session id — this tool is a **named view** over trace
 * history. Auto-attach (every subsequent tool call written under the
 * created session) is intentionally not in v1: it would entangle the
 * tool dispatch path with mutable session state, and the resume
 * surface gives most of the value without that complexity.
 *
 * Macro args substitution: `${0}`, `${1}`, ... in any string-typed
 * arg of any step replaces with the corresponding positional from
 * the macro_run `args` array. Keeps the recipe shape simple — no
 * named parameters, no nested templates.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { errMsg } from '../../errors.js';
import { generateSessionId } from '../../trace/logger.js';
import {
  insertSession,
  findSessionByLabel,
  getSessionById,
  recentSessions,
  callsForSession,
  deleteSession,
  type SessionRow,
} from '../../db/queries-trace.js';
import { saveMacro, getMacro, listMacros, bumpMacroRun, deleteMacro, type MacroStep } from '../../db/queries-macros.js';
import { textResult, truncateOutput } from './shared.js';
import { getToolModule } from './registry.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { fmtTs, renderSavedMacros, renderSessionRecent } from './_session-specs.js';

/**
 * Cap on the per-call args snippet rendered in resume output. A few
 * chars under leaves room for the trailing ellipsis.
 */
const RESUME_ARGS_SNIPPET_BUDGET = 80;
/** Content cap (77 chars) — `BUDGET - 3` for the `...` ellipsis tail. */
const RESUME_ARGS_SNIPPET_TRUNCATE_AT = 77;

/** Cap on the per-call result-summary snippet rendered in resume output. */
const RESUME_RESULT_SNIPPET_BUDGET = 100;
/** Content cap (97 chars) — `BUDGET - 3` for the `...` ellipsis tail. */
const RESUME_RESULT_SNIPPET_TRUNCATE_AT = 97;

/** Apply a budget+truncate-at pair to one snippet string for the
 *  resume render. Lifted out of `handleResume` so the rendering loop
 *  doesn't carry two ternaries. */
function clipSnippet(s: string, budget: number, truncateAt: number): string {
  if (s.length <= budget) return s;
  return s.slice(0, truncateAt) + '…';
}

/* ---------- create ---------- */

function handleCreate(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const label = typeof args['label'] === 'string' && args['label'] ? args['label'] : undefined;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const id = generateSessionId();
  insertSession({ qb: cg.queries, id, startedTs: Date.now(), ...(label ? { label } : {}) });
  const lines = [`## Session created`, '', `- **id:** \`${id}\``];
  if (label) lines.push(`- **label:** \`${label}\``);
  lines.push(
    '',
    `> This records a labelled session marker. To replay a session's tool-call history, ` +
      `pass the \`id\` or \`label\` of a **process session** (one that actually accumulated calls) ` +
      `to \`cartograph_session({action: 'resume'})\`. Use \`action: 'list'\` to see those sessions.`,
  );
  return ok(textResult(lines.join('\n')));
}

/* ---------- resume ---------- */

function handleResume(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const id = typeof args['id'] === 'string' ? args['id'] : undefined;
  const label = typeof args['label'] === 'string' ? args['label'] : undefined;
  if (!id && !label) {
    return err(`cartograph_session(action='resume'): pass either 'id' or 'label' to identify the session.`);
  }
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const session = lookupSession(cg, id, label);
  if (!session) {
    const lookupLabel = id ? `id=${id}` : `label=${label}`;
    return err(
      `No session matched ${lookupLabel}. ` + `Use \`cartograph_session({action: 'list'})\` to see recent sessions.`,
    );
  }
  const calls = callsForSession(cg.queries, session.id);
  return ok(textResult(truncateOutput(formatResumeReport(session, calls))));
}

/** Resolve a session from id (preferred) and/or label (fallback). */
function lookupSession(
  cg: ReturnType<ToolCtx['getCartograph']>,
  id: string | undefined,
  label: string | undefined,
): SessionRow | null {
  let session: SessionRow | null = null;
  if (id) session = getSessionById(cg.queries, id);
  if (!session && label) session = findSessionByLabel(cg.queries, label);
  return session;
}

/** Render the resume markdown card: header + tool-call history (or empty notice). */
function formatResumeReport(session: SessionRow, calls: ReturnType<typeof callsForSession>): string {
  const labelPrefix = session.label ? `\`${session.label}\` ` : '';
  const lines: string[] = [
    `## Resume session ${labelPrefix}(${session.id})`,
    '',
    `- **started:** ${fmtTs(session.startedTs)}  •  ` +
      `**last activity:** ${fmtTs(session.lastActivityTs)}  •  ` +
      `**calls:** ${session.toolCount}`,
    '',
  ];
  if (calls.length === 0) {
    lines.push(
      "_No tool calls recorded under this session. Only process sessions (auto-created per server run) accumulate calls; labelled sessions created via `action: 'create'` are markers only._",
    );
    return lines.join('\n');
  }
  lines.push('### Tool call history', '');
  for (const c of calls) {
    const argSnippet = clipSnippet(c.argsJson, RESUME_ARGS_SNIPPET_BUDGET, RESUME_ARGS_SNIPPET_TRUNCATE_AT);
    const summarySnippet = clipSnippet(
      c.resultSummary,
      RESUME_RESULT_SNIPPET_BUDGET,
      RESUME_RESULT_SNIPPET_TRUNCATE_AT,
    );
    lines.push(`${c.step}. **${c.toolName}** \`${argSnippet}\` — ${summarySnippet} _(${c.durationMs}ms)_`);
  }
  return lines.join('\n');
}

/* ---------- list ---------- */

/** Total session-row count — for the "showing N of M" list footer.
 *  A direct COUNT keeps the change inside the session-tool file scope
 *  (the `recentSessions` query lives in a different domain file). */
function totalSessionCount(cg: ReturnType<ToolCtx['getCartograph']>): number {
  const row = cg.queries.db.prepare('SELECT COUNT(*) AS n FROM mcp_sessions').get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function handleList(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  // `limit` is range-enforced ([1, 100] integer) by the Zod schema at
  // the dispatch boundary and carries a default of 20 — out-of-range
  // input is rejected there, not clamped, so the parsed args always
  // supply a valid value.
  const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const sessions = recentSessions(cg.queries, limit);
  // Skip the `totalSessionCount` query on the empty path — the
  // spec's `emptyState` short-circuits the renderer to the empty
  // note verbatim before `total` is read.
  const total = sessions.length === 0 ? 0 : totalSessionCount(cg);
  return ok(textResult(renderSessionRecent({ sessions, total })));
}

/* ---------- delete ---------- */

function handleDelete(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const id = typeof args['id'] === 'string' ? args['id'] : undefined;
  const label = typeof args['label'] === 'string' ? args['label'] : undefined;
  if (!id && !label) {
    return err(`cartograph_session(action='delete'): pass either 'id' or 'label' to identify the session.`);
  }
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const session = lookupSession(cg, id, label);
  if (!session) {
    const lookupLabel = id ? `id=${id}` : `label=${label}`;
    return err(
      `No session matched ${lookupLabel}. ` + `Use \`cartograph_session({action: 'list'})\` to see recent sessions.`,
    );
  }
  deleteSession(cg.queries, session.id);
  const labelPart = session.label ? ` \`${session.label}\`` : '';
  return ok(
    textResult(
      `Deleted session \`${session.id}\`${labelPart} and its ` +
        `${session.toolCount} recorded call${session.toolCount === 1 ? '' : 's'}.`,
    ),
  );
}

/* ---------- macros ---------- */

function validateSteps(raw: unknown): MacroStep[] | string {
  if (!Array.isArray(raw)) return `'steps' must be an array of {tool, args} objects.`;
  // A 0-step macro is meaningless — it occupies a name in `macro_list`
  // and replays nothing. Reject it so a botched `steps` payload (e.g. a
  // stringified JSON that deserialised to `[]`) surfaces as an error
  // rather than a cheerful "Macro saved" (friction audit-4 #4).
  if (raw.length === 0) return 'steps must contain at least one {tool, args} step.';
  const out: MacroStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object') return `steps[${i}] must be an object.`;
    const obj = s as Record<string, unknown>;
    const tool = obj['tool'];
    if (typeof tool !== 'string' || !tool) return `steps[${i}].tool must be a non-empty string.`;
    const argsField = obj['args'] ?? {};
    if (typeof argsField !== 'object' || Array.isArray(argsField)) {
      return `steps[${i}].args must be an object (got ${JSON.stringify(argsField)}).`;
    }
    out.push({ tool, args: argsField as Record<string, unknown> });
  }
  return out;
}

function handleMacroSave(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const name = args['name'];
  if (typeof name !== 'string' || !name) return err(`'name' must be a non-empty string.`);
  const steps = validateSteps(args['steps']);
  if (typeof steps === 'string') return err(steps);
  for (const s of steps) {
    if (!getToolModule(s.tool)) {
      return err(`Step references unknown tool: \`${s.tool}\`. Run \`list_tools\` to see valid names.`);
    }
  }
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  saveMacro({ qb: cg.queries, name, steps, ts: Date.now() });
  return ok(
    textResult(
      `## Macro saved\n\n- **name:** \`${name}\`\n- **steps:** ${steps.length}\n\n` +
        `Run with \`cartograph_session({action: 'macro_run', name: '${name}', args: [...] })\`. ` +
        `Positional \`args[i]\` substitute into any string-typed arg matching \`\${i}\`.`,
    ),
  );
}

/**
 * Strip the `> _call: c_xxxxxxxx_` delta-cursor footer emitted by
 * `cartograph_find` and a handful of other tools. When a macro replays
 * a `cartograph_find` call the footer bleeds into the macro output and
 * can be mistaken for the macro's own pagination cursor. The cursor is
 * a tool-to-tool pagination hint — it has no value in the composed
 * macro output. Lines matching the footer pattern are removed; the rest
 * of the body is returned unchanged.
 *
 * Pattern (see `appendCallIdFooter` in `shared.ts`): a line that
 * looks like
 *   `> _call: \`c_<hex>\`_  •  pass as \`since\` for delta-only follow-ups.`
 * The call id is backtick-wrapped, so we match on the literal
 * `> _call:` prefix and tolerate the optional backtick before `c_`
 * to stay stable across minor wording changes.
 */
function stripSinceCursorFooter(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^> _call: `?c_/.test(line.trimStart()))
    .join('\n')
    .trimEnd();
}

/**
 * Substitute `${0}` … `${n}` placeholders with positional macro args.
 *
 * Recurses into nested arrays and objects so a placeholder inside e.g.
 * `args: { ranges: [{ file: '${0}' }] }` is substituted — the previous
 * implementation only walked top-level string values and silently left
 * any nested `${i}` untouched.
 *
 * When a string value is *exactly* a single `${i}` placeholder and the
 * corresponding positional arg is non-string (number / boolean / etc.),
 * the raw value is substituted so a numeric/boolean arg keeps its type
 * instead of being stringified. Placeholders embedded in a larger
 * string still interpolate as text.
 */
function substituteOne(v: unknown, positional: unknown[]): unknown {
  if (typeof v === 'string') {
    const wholeMatch = /^\$\{(\d+)\}$/.exec(v);
    if (wholeMatch) {
      const replacement = positional[Number(wholeMatch[1])];
      return replacement === undefined ? v : replacement;
    }
    return v.replaceAll(/\$\{(\d+)\}/g, (_m, idx) => {
      const replacement = positional[Number(idx)];
      return replacement === undefined ? `\${${idx}}` : stringifyMacroReplacement(replacement);
    });
  }
  if (Array.isArray(v)) return v.map((el) => substituteOne(el, positional));
  if (v && typeof v === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      obj[k] = substituteOne(val, positional);
    }
    return obj;
  }
  return v;
}

function stringifyMacroReplacement(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value) ?? '<unserializable>';
  } catch {
    return '<unserializable>';
  }
}

function substituteArgs(args: Record<string, unknown>, positional: unknown[]): Record<string, unknown> {
  return substituteOne(args, positional) as Record<string, unknown>;
}

/**
 * Recursion guard for `macro_run`. A macro step can itself be a
 * `cartograph_session({action: 'macro_run'})` call, so a self- or
 * mutually-referential macro would otherwise recurse without bound and
 * blow the stack. We track the set of macro names currently on the
 * run stack: a re-entry into a name already running is rejected, and a
 * hard depth cap bounds even acyclic but deeply-nested chains.
 */
const MACRO_RUN_MAX_DEPTH = 8;
// Module-level run stack. The MCP server dispatches tool calls one at a
// time (no concurrent handler execution), so a macro's nested steps are
// the only thing that ever pushes here — the stack is effectively
// per-invocation. If the dispatcher ever runs handlers concurrently this
// must become a per-call context threaded through `runMacroSteps`.
const macroRunStack: string[] = [];

async function handleMacroRun(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const name = args['name'];
  if (typeof name !== 'string' || !name) return err(`'name' must be a non-empty string.`);
  const positional = Array.isArray(args['args']) ? (args['args'] as unknown[]) : [];
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const macro = getMacro(cg.queries, name);
  if (!macro) {
    return err(`No macro named \`${name}\`. Use \`action: 'macro_list'\` to see saved macros.`);
  }
  if (macroRunStack.includes(name)) {
    const stack = macroRunStack.map((n) => `\`${n}\``).join(' → ');
    return err(
      `Macro \`${name}\` is already running — recursive macro_run detected ` +
        `(run stack: ${stack} → \`${name}\`). ` +
        `A macro must not invoke itself, directly or via another macro.`,
    );
  }
  if (macroRunStack.length >= MACRO_RUN_MAX_DEPTH) {
    const stack = macroRunStack.map((n) => `\`${n}\``).join(' → ');
    return err(`Macro nesting too deep (limit ${MACRO_RUN_MAX_DEPTH}); ` + `run stack: ${stack}.`);
  }
  macroRunStack.push(name);
  try {
    return await runMacroSteps({ ctx, name, macro, positional, cg });
  } finally {
    macroRunStack.pop();
  }
}

/** Bundled args for {@link runMacroSteps}. */
interface RunMacroStepsArgs {
  /** The MCP tool-call context. */
  readonly ctx: ToolCtx;
  /** The macro's name. */
  readonly name: string;
  /** The macro definition — its ordered list of steps. */
  readonly macro: { steps: MacroStep[] };
  /** Positional arguments substituted into each step's args. */
  readonly positional: unknown[];
  /** The resolved Cartograph instance for this project. */
  readonly cg: ReturnType<ToolCtx['getCartograph']>;
}

async function runMacroSteps(args: RunMacroStepsArgs): Promise<ToolOutcome> {
  const { ctx, name, macro, positional, cg } = args;
  const sections: string[] = [
    `## Macro \`${name}\` — ${macro.steps.length} step${macro.steps.length === 1 ? '' : 's'}`,
    '',
  ];
  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i]!;
    const mod = getToolModule(step.tool);
    if (!mod) {
      sections.push(`### Step ${i + 1}: \`${step.tool}\` — **error**\n\nUnknown tool.`);
      continue;
    }
    const concreteArgs = substituteArgs(step.args, positional);
    const t0 = Date.now();
    let body: string;
    try {
      const result = await mod.handle(ctx, concreteArgs);
      body = stripSinceCursorFooter(result.content?.[0]?.text ?? '_(no text content)_');
    } catch (error_) {
      body = `_step error: ${errMsg(error_)}_`;
    }
    const dur = Date.now() - t0;
    sections.push(
      `### Step ${i + 1}: \`${step.tool}\` (${dur}ms)\n` + `\`${JSON.stringify(concreteArgs)}\`\n\n${body}`,
    );
  }
  bumpMacroRun(cg.queries, name, Date.now());
  return ok(textResult(truncateOutput(sections.join('\n\n'))));
}

function handleMacroList(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const macros = listMacros(cg.queries);
  return ok(textResult(renderSavedMacros({ macros })));
}

function handleMacroDelete(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const name = args['name'];
  if (typeof name !== 'string' || !name) return err(`'name' must be a non-empty string.`);
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const removed = deleteMacro(cg.queries, name);
  return ok(textResult(removed ? `Deleted macro \`${name}\`.` : `No macro named \`${name}\`.`));
}

/* ---------- dispatch ---------- */

/**
 * Zod schema for `cartograph_session` — a flat `action`-discriminated
 * family. Every per-action field is `.optional()` (or carries a
 * `.default()`), matching the legacy hand-written JSON `inputSchema`,
 * which never enforced per-action required fields either; cross-field
 * checks (e.g. `id`-or-`label` for resume/delete, `name` for the
 * macro actions, `steps` shape) stay in the action handlers.
 *
 * `limit` carries its documented bound — out-of-range input is
 * REJECTED at the dispatch boundary (locked decision), never clamped.
 */
const sessionSchema = z.object({
  action: z
    .enum(['create', 'resume', 'list', 'delete', 'macro_save', 'macro_run', 'macro_list', 'macro_delete'])
    .describe(
      'Sessions: `create` / `resume` / `list` / `delete`. Macros: `macro_save` / `macro_run` / `macro_list` / `macro_delete`.',
    ),
  id: z.string().optional().describe('(resume / delete) Session id from create.'),
  label: z.string().optional().describe('(create) Human label. (resume / delete) Look up by label when id is unknown.'),
  name: z
    .string()
    .optional()
    .describe('(macro_save / macro_run / macro_delete) Macro name; re-saving the same name overwrites.'),
  steps: z
    // Each step is a `{tool, args}` object; `validateSteps` performs
    // the deep structural check, so the schema only asserts the
    // array-of-objects shape the legacy `items: { type: 'object' }`
    // advertised.
    .array(z.looseObject({}))
    .optional()
    .describe('(macro_save) Ordered list of `{tool, args}` objects, each referencing an MCP tool by name.'),
  args: z
    // Positional argument array. The legacy JSON advertised
    // `items: { type: 'string' }` but `substituteOne` accepts
    // non-string positionals (numbers / booleans keep their type when
    // a whole-string `${i}` is substituted) and the bespoke validator
    // only warned on a mismatch. `z.unknown()` keeps that permissive
    // contract — a strict `z.string()` element would newly reject a
    // numeric positional arg.
    .array(z.unknown())
    .optional()
    .describe("(macro_run) Positional args; `${0}`/`${1}`/… in any step's string args are replaced by matching index."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('(list) Max sessions to return (default 20, integer 1-100).'),
  projectPath: projectPathField,
});

type SessionArgs = z.infer<typeof sessionSchema>;

async function handleSession(ctx: ToolCtx, args: SessionArgs): Promise<ToolOutcome> {
  // `action` is enum-validated by Zod, so the switch is exhaustive —
  // no `default` arm is reachable. The per-action handlers read keys
  // off a `Record<string, unknown>` view; the parsed args are
  // structurally a superset, so the cast is safe.
  const raw = args as Record<string, unknown>;
  switch (args.action) {
    case 'create':
      return handleCreate(ctx, raw);
    case 'resume':
      return handleResume(ctx, raw);
    case 'list':
      return handleList(ctx, raw);
    case 'delete':
      return handleDelete(ctx, raw);
    case 'macro_save':
      return handleMacroSave(ctx, raw);
    case 'macro_run':
      return handleMacroRun(ctx, raw);
    case 'macro_list':
      return handleMacroList(ctx, raw);
    case 'macro_delete':
      return handleMacroDelete(ctx, raw);
  }
}

export const SESSION_TOOL = defineTool({
  name: 'cartograph_session',
  description:
    'Session state + tool-call macros — resume investigations and replay recipes.\n\n' +
    'Sessions: `create` / `resume` (id or label) / `list` / `delete` (id or label). ' +
    'Macros: `macro_save` (`{name, steps}`) / `macro_run` (substitutes `${0}`/`${1}`/… from runtime args) / `macro_list` / `macro_delete`.',
  schema: sessionSchema,
  handle: handleSession,
  bypassFreshnessGate: true,
  isWriteTool: true,
  readOnlyActions: new Set(['list', 'resume', 'macro_list']),
});
