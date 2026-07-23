/**
 * `cartograph_session({action})` — agent session state + macros (#13).
 *
 * Nine actions on the consolidated family pattern from #7:
 *
 *   - `create  ({label})`            → mint a labelled session row
 *   - `resume  ({id?, label?})`      → render compact summary of prior calls
 *   - `audit   ({id?, label?})`      → review a session's tool-use pattern
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
import { macroStepContractsSchema } from '../../features/session/runtime.js';
import { projectPathField } from './_common-fields.js';
import { errMsg } from '../../errors.js';
import { asJsonObject } from '../../json-object.js';
import { generateSessionId } from '../../trace/logger.js';
import {
  insertSession,
  findSessionByLabel,
  getSessionById,
  recentSessions,
  callsForSession,
  deleteSession,
  getTraceUsage,
  type SessionRow,
  type TraceUsageSummary,
} from '../../db/queries-trace.js';
import { saveMacro, getMacro, listMacros, bumpMacroRun, deleteMacro, type MacroStep } from '../../db/queries-macros.js';
import { textResult, truncateOutput } from './shared.js';
// From the leaf lookup, NOT registry.js — registry imports SESSION_TOOL to
// build its ENTRIES, so importing getToolModule from registry here would
// re-create the runtime cycle this split removes.
import { getToolModule } from './_tool-lookup.js';
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

/* ---------- audit ---------- */

type SessionCall = ReturnType<typeof callsForSession>[number];

interface AuditFinding {
  severity: 'warning' | 'info';
  text: string;
}

function handleAudit(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const id = typeof args['id'] === 'string' ? args['id'] : undefined;
  const label = typeof args['label'] === 'string' ? args['label'] : undefined;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const session = lookupAuditSession(cg, id, label);
  if (!session) {
    const lookupLabel = auditLookupLabel(id, label);
    return err(
      `No session matched ${lookupLabel}. ` +
        `Use \`cartograph_session({action: 'list'})\` to see recent sessions with recorded calls.`,
    );
  }
  const calls = callsForSession(cg.queries, session.id);
  return ok(textResult(truncateOutput(formatAuditReport(session, calls))));
}

function auditLookupLabel(id: string | undefined, label: string | undefined): string {
  if (id) return `id=${id}`;
  if (label) return `label=${label}`;
  return 'latest non-empty session';
}

function lookupAuditSession(
  cg: ReturnType<ToolCtx['getCartograph']>,
  id: string | undefined,
  label: string | undefined,
): SessionRow | null {
  if (id || label) return lookupSession(cg, id, label);
  return recentSessions(cg.queries, 20).find((s) => s.toolCount > 0) ?? null;
}

function parseArgsJson(argsJson: string): Record<string, unknown> {
  try {
    return asJsonObject(JSON.parse(argsJson)) ?? {};
  } catch {
    return {};
  }
}

function findRepeatedCalls(calls: ReadonlyArray<SessionCall>): AuditFinding[] {
  const byKey = new Map<string, { call: SessionCall; count: number }>();
  for (const call of calls) {
    const key = `${call.toolName}\n${call.argsJson}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
    } else {
      byKey.set(key, { call, count: 1 });
    }
  }
  return [...byKey.values()]
    .filter((entry) => entry.count > 1)
    .slice(0, 5)
    .map(({ call, count }) => ({
      severity: 'info',
      text:
        `Repeated equivalent call: \`${call.toolName}\` with the same args ran ${count} times. ` +
        'Reuse the prior result or a `since` cursor when the tool supports it.',
    }));
}

function sourceHeavyFinding(call: SessionCall): AuditFinding | null {
  const args = parseArgsJson(call.argsJson);
  if (call.toolName === 'cartograph_context') {
    const askedForCode = args['code'] !== false && args['includeCode'] !== false;
    if (askedForCode && args['lowTokens'] !== true && args['format'] !== 'plan') {
      return {
        severity: 'warning',
        text:
          `Source-heavy context call at step ${call.step}: \`cartograph_context\` included code in the main path. ` +
          'Use `lowTokens: true` or `format: "plan"` first when routing a large investigation.',
      };
    }
  }
  if (call.toolName === 'cartograph_explore' && args['summary'] !== true && args['lowTokens'] !== true) {
    return {
      severity: 'warning',
      text:
        `Source-heavy exploration at step ${call.step}: \`cartograph_explore\` returned source blocks. ` +
        'Use `summary: true` or `lowTokens: true` until the target files are clear.',
    };
  }
  if (call.toolName === 'cartograph_node' && args['code'] === true && args['detail'] === 'full') {
    return {
      severity: 'info',
      text:
        `Full source body requested at step ${call.step}. ` +
        'Prefer `detail: "preview"` while scouting, then fetch full only for the edit target.',
    };
  }
  return null;
}

function buildAuditFindings(calls: ReadonlyArray<SessionCall>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const call of calls) {
    const sourceHeavy = sourceHeavyFinding(call);
    if (sourceHeavy) findings.push(sourceHeavy);
    if (call.durationMs >= 2_000) {
      findings.push({
        severity: 'info',
        text: `Slow call at step ${call.step}: \`${call.toolName}\` took ${call.durationMs}ms.`,
      });
    }
    if (/error|failed|exception/i.test(call.resultSummary)) {
      findings.push({
        severity: 'warning',
        text: `Error-like result at step ${call.step}: \`${call.toolName}\` summary was "${call.resultSummary}".`,
      });
    }
  }
  findings.push(...findRepeatedCalls(calls));

  if (
    calls.length > 0 &&
    !calls.some((c) => c.toolName === 'cartograph_verify' || c.toolName === 'cartograph_compare_to_ref')
  ) {
    findings.push({
      severity: 'info',
      text: 'No end-of-task self-check recorded. Before reporting done after edits, call ' + '`cartograph_verify`.',
    });
  }
  if (
    calls.length > 0 &&
    !calls.some(
      (c) =>
        c.toolName === 'cartograph_verify' ||
        c.toolName === 'cartograph_affected' ||
        c.toolName === 'cartograph_tests_for',
    )
  ) {
    findings.push({
      severity: 'info',
      text: 'No test-selection call recorded. For code edits, use `cartograph_verify`; use `cartograph_tests_for` for one symbol.',
    });
  }

  return findings.slice(0, 12);
}

function formatToolCounts(calls: ReadonlyArray<SessionCall>): string {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => `\`${name}\` ×${count}`)
    .join(', ');
}

function suggestedAuditActions(calls: ReadonlyArray<SessionCall>): string[] {
  const actions: string[] = [];
  if (!calls.some((c) => c.toolName === 'cartograph_verify' || c.toolName === 'cartograph_compare_to_ref')) {
    actions.push('`cartograph_verify`');
  }
  if (
    !calls.some(
      (c) =>
        c.toolName === 'cartograph_verify' ||
        c.toolName === 'cartograph_affected' ||
        c.toolName === 'cartograph_tests_for',
    )
  ) {
    actions.push('`cartograph_verify` after edits, or `cartograph_tests_for({symbol})` for one target.');
  }
  if (calls.some((c) => c.toolName === 'cartograph_context' && parseArgsJson(c.argsJson)['format'] !== 'plan')) {
    actions.push('`cartograph_context({task, format: "plan"})` for the next broad route decision.');
  }
  return actions;
}

function formatAuditReport(session: SessionRow, calls: ReadonlyArray<SessionCall>): string {
  const labelPrefix = session.label ? `\`${session.label}\` ` : '';
  const lines: string[] = [
    `## Session audit ${labelPrefix}(${session.id})`,
    '',
    `- **started:** ${fmtTs(session.startedTs)}  •  ` +
      `**last activity:** ${fmtTs(session.lastActivityTs)}  •  ` +
      `**calls:** ${calls.length}`,
  ];
  if (calls.length === 0) {
    lines.push('', '_No tool calls recorded under this session._');
    return lines.join('\n');
  }

  const counts = formatToolCounts(calls);
  if (counts) lines.push(`- **top tools:** ${counts}`);

  const findings = buildAuditFindings(calls);
  lines.push('', '### Findings', '');
  if (findings.length === 0) {
    lines.push('_No risky navigation patterns detected._');
  } else {
    for (const f of findings) {
      const prefix = f.severity === 'warning' ? 'warning' : 'info';
      lines.push(`- **${prefix}:** ${f.text}`);
    }
  }

  const actions = suggestedAuditActions(calls);
  if (actions.length > 0) {
    lines.push('', '### Suggested next actions', '');
    for (const action of actions.slice(0, 5)) lines.push(`- ${action}`);
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
  const result = macroStepContractsSchema.safeParse(raw);
  return result.success ? result.data : describeMacroStepValidationError(raw, result.error);
}

function describeMacroStepValidationError(raw: readonly unknown[], error: z.ZodError): string {
  const issue = error.issues[0];
  const index = issue?.path[0];
  const field = issue?.path[1];
  if (typeof index !== 'number') return `'steps' must be an array of {tool, args} objects.`;
  if (field === undefined) return `steps[${index}] must be an object.`;
  if (field === 'tool') return `steps[${index}].tool must be a non-empty string.`;
  if (field === 'args') {
    const step = raw[index];
    const argsField = isRecord(step) && Object.hasOwn(step, 'args') ? step['args'] : undefined;
    return `steps[${index}].args must be an object (got ${JSON.stringify(argsField)}).`;
  }
  return `steps[${index}] must be a {tool, args} object.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
export function substituteOne(v: unknown, positional: unknown[]): unknown {
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

function handleUsage(ctx: ToolCtx, args: Record<string, unknown>): ToolOutcome {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  return ok(textResult(formatUsageReport(getTraceUsage(cg.queries))));
}

function formatUsageReport(usage: TraceUsageSummary): string {
  const lines = [
    '## MCP Usage',
    '',
    `- **sessions:** ${usage.sessionCount}`,
    `- **tool calls:** ${usage.toolCallCount}`,
    `- **error-like summaries:** ${usage.errorLikeCount}`,
    '',
  ];
  if (usage.tools.length === 0) {
    lines.push('_No tool calls recorded yet._');
    return lines.join('\n');
  }
  lines.push('| Tool | Calls | p50 | p95 | Max |', '| --- | ---: | ---: | ---: | ---: |');
  for (const tool of usage.tools) {
    lines.push(
      `| ${tool.toolName} | ${tool.callCount} | ${tool.p50DurationMs}ms | ${tool.p95DurationMs}ms | ${tool.maxDurationMs}ms |`,
    );
  }
  return lines.join('\n');
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
    .enum([
      'create',
      'resume',
      'audit',
      'list',
      'delete',
      'usage',
      'macro_save',
      'macro_run',
      'macro_list',
      'macro_delete',
    ])
    .describe(
      'Sessions: `create` / `resume` / `audit` / `list` / `delete` / `usage`. Macros: `macro_save` / `macro_run` / `macro_list` / `macro_delete`.',
    ),
  id: z.string().optional().describe('(resume / audit / delete) Session id from create.'),
  label: z
    .string()
    .optional()
    .describe('(create) Human label. (resume / audit / delete) Look up by label when id is unknown.'),
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
    case 'audit':
      return handleAudit(ctx, raw);
    case 'list':
      return handleList(ctx, raw);
    case 'delete':
      return handleDelete(ctx, raw);
    case 'usage':
      return handleUsage(ctx, raw);
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
    'Sessions: `create` / `resume` (id or label) / `audit` (id, label, or latest non-empty) / `list` / `delete` (id or label) / `usage` (aggregate counts only). ' +
    'Macros: `macro_save` (`{name, steps}`) / `macro_run` (substitutes `${0}`/`${1}`/… from runtime args) / `macro_list` / `macro_delete`.',
  schema: sessionSchema,
  handle: handleSession,
  bypassFreshnessGate: true,
  isWriteTool: true,
  readOnlyActions: new Set(['list', 'resume', 'audit', 'usage', 'macro_list']),
});
