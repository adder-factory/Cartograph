/**
 * cartograph_find — unified "find a thing in the codebase" tool.
 *
 * The 2026-05-11 three-tool merge collapsed `cartograph_search`,
 * `cartograph_grep`, and `cartograph_string_refs` into one entry point.
 * The agent picks the slice via `by:`; per-axis helpers in the
 * `_search.ts` / `_grep.ts` / `_string_refs.ts` private modules
 * preserve every behavior the three originals shipped (four search
 * modes with FTS / fuzzy / semantic / intent, regex content search
 * with enclosing-symbol attribution, env-var / SQL-table reference
 * tables, the full `compact` / `fields` / `since` / `key` / `op`
 * surface).
 *
 * Axis matrix:
 *
 *   by='name'    → handleFindByName    (was cartograph_search)
 *   by='content' → handleFindByContent (was cartograph_grep)
 *   by='env'     → handleFindByEnv     (was cartograph_string_refs kind=env)
 *   by='sql'     → handleFindBySql     (was cartograph_string_refs kind=sql)
 *
 * `mode:` is honoured only when `by: 'name'` (search modes —
 * exact / fuzzy / semantic / intent). Passing `mode` with any other
 * `by:` value returns an error so the agent doesn't silently get the
 * default behavior of the wrong backend.
 *
 * `'concept'` axis was considered and dropped. It would have been a
 * synonym for `{by: 'name', mode: 'semantic'}` with no behavior delta;
 * adding it as a sibling to 'name' would have made the schema lie about
 * its own structure ('concept' isn't a kind of thing — it's a search
 * MODE over names). Discoverability is recovered in the description.
 *
 * NOTE on `since`: the `c_xxxxxxxx` delta-mode UIDs minted by the old
 * `cartograph_search` / `cartograph_grep` were scoped to those tool
 * names. The new mint scope is `cartograph_find:<axis>` (per-axis to
 * keep delta-mode caches addressable). UIDs minted before this merge
 * will not resolve under `cartograph_find` — the response just falls
 * back to a full result with the standard "call id is no longer
 * cached" warning. Acceptable for an API-break refactor.
 *
 * SCHEMA SHAPE (structural campaign P4 wave 2 — `defineTool`/Zod).
 * `find` is a FAMILY tool with a `by` discriminator whose per-axis
 * fields differ wildly. The Zod schema is a FLAT `z.object` — `by` is
 * a `z.enum`, every per-axis field is `.optional()`, mirroring the
 * union-of-all-axes shape the hand-written JSON `inputSchema` always
 * had. A strict `z.discriminatedUnion` would newly reject calls valid
 * today; out of scope. Every cross-field / per-axis check (mode⇄axis
 * compatibility, knob compatibility, query-required) stays in the
 * handler verbatim.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { validateStringOutcome } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, err } from './_outcome.js';

import { handleFindByName } from './_search.js';
import { handleFindByContent } from './_grep.js';
import { handleFindByEnv, handleFindBySql } from './_string_refs.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Public-facing axis values. */
type FindAxis = 'name' | 'content' | 'env' | 'sql';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

/**
 * Flat Zod schema for `cartograph_find`. Field names, enum values, and
 * `.describe()` text are copied verbatim from the pre-migration
 * hand-written JSON `inputSchema`. Every per-axis field is
 * `.optional()` so the schema accepts the same arg union the legacy
 * tool did — per-axis enforcement stays in the handler.
 *
 * `limit` is left as `.int().min(1)` with NO `.max()`: the documented
 * maximum is per-axis (by='name' 100, by='content'/'env'/'sql' 500),
 * and one field cannot carry two maxima. The per-axis upper bound is
 * enforced inside the `_search.ts` / `_grep.ts` / `_string_refs.ts`
 * helpers (by='name' clamps over-100 with a `> Requested limit …`
 * note). See the OUTPUT report for the deferred follow-up.
 *
 * DEFERRED: the legacy sibling-enum hint ("'semantic' is a search
 * `mode`, not an axis — did you mean `by: 'name', mode: 'semantic'`?")
 * is NOT preserved. Restoring it needs a `.superRefine`, which turns
 * the schema into a `ZodEffects` — incompatible with `defineTool`'s
 * `z.ZodObject` bound without widening `ToolZodSchema` in the shared
 * `_define-tool.ts`. An invalid `by` now gets the plain Zod enum
 * rejection ("must be one of 'name', 'content', 'env', 'sql'").
 */
const findSchema = z.object({
  by: z
    .enum(['name', 'content', 'env', 'sql'])
    .describe(
      "Axis selector. `'name'` finds symbols by name (with `mode`); `'content'` greps file content (regex, enclosing-symbol attribution); `'env'` lists env-var read sites; `'sql'` lists SQL table reference sites.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      'Search input. (name/exact) Symbol name + field-qualified tokens (kind:, lang:, path:, name:, sig:, callers-of:, callees-of:, depends-on:, centrality:, sort:). ' +
        '(name/fuzzy) Name or misspelt name (case-insensitive). ' +
        '(name/semantic) Free-text concept query — mutually exclusive with `symbol`. ' +
        '(name/intent) Behavior phrase, e.g. "verify JWT signature". ' +
        '(content) JavaScript-style regex; `^`/`$` match line boundaries. ' +
        '(env/sql) Ignored — use `key` to filter to one variable/table.',
    ),
  mode: z
    .enum(['exact', 'fuzzy', 'semantic', 'intent'])
    .optional()
    .describe(
      "(by='name' only) `exact` (default — name + FTS query language), `fuzzy` (typos), `semantic` (concept; embeddings — pair with `query` or `symbol`), `intent` (behavior; FTS5 over summaries + docstrings + test descriptions). Error if passed with another `by:`.",
    ),
  symbol: z
    .string()
    .optional()
    .describe('(name/semantic only) Source symbol name to find peers of. Mutually exclusive with `query`.'),
  kind: z
    .enum([
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'protocol',
      'function',
      'method',
      'property',
      'field',
      'variable',
      'constant',
      'enum',
      'enum_member',
      'type_alias',
      'namespace',
      'parameter',
      'import',
      'export',
      'route',
      'component',
      'table',
      'resource',
    ])
    .optional()
    .describe('(name, exact/fuzzy) Filter by node kind (e.g. `type_alias`, not `type`).'),
  sameLanguage: z
    .boolean()
    .optional()
    .describe("(name/semantic + symbol) Restrict peers to the source symbol's language."),
  differentLanguage: z
    .boolean()
    .optional()
    .describe('(name/semantic + symbol) Restrict to a different language (cross-language matching).'),
  languageFilter: z
    .string()
    .optional()
    .describe('(name/semantic + query) Restrict cluster results to one language (e.g. "typescript").'),
  caseSensitive: z.boolean().optional().describe("(by='content' only) Default false (case-insensitive regex)."),
  pathFilter: z
    .string()
    .optional()
    .describe(
      "Restrict to files whose path STARTS WITH this prefix (e.g. \"src/mcp/\"). Honoured on `by: 'content'` and `by: 'name', mode: 'intent'`.",
    ),
  language: z
    .string()
    .optional()
    .describe('(by=\'content\') Restrict to one language (e.g. "typescript"). Case-insensitive.'),
  key: z
    .string()
    .optional()
    .describe(
      "(env/sql only) Key to look up — env-var name for by='env', table name (case-insensitive) for by='sql'. Omit for the top-N listing.",
    ),
  op: z
    .enum(['read', 'write', 'ddl'])
    .optional()
    .describe(
      "(by='sql' only) Filter to one operation: read (SELECT/JOIN), write (INSERT/UPDATE/DELETE), or ddl (CREATE/ALTER/DROP).",
    ),
  includeTests: z
    .boolean()
    .optional()
    .describe(
      '(env/sql) Default true: keep test-only keys/tables but rank prod usage first. False: hide test-only entries.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Maximum results. Defaults: by='name' 10 (max 100); by='content' 50 (max 500); by='env'/'sql' 30 (max 500).",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "Delta mode — pass a `c_xxxxxxxx` UID from a prior call to return only rows absent from that result; the footer always ends with a fresh `c_xxxxxxxx` marker. Honoured on `by: 'name'` (mode='exact') and `by: 'content'`. Unknown UIDs fall back to the full result with a warning. Error if used with name + fuzzy/semantic/intent.",
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      '(name/exact only) Default false. When true, emit terse `name|kind|path:line[|sig:<...>][|id:n_xxxxxxxx]` rows instead of markdown headers.',
    ),
  fields: z
    .array(z.enum(['name', 'kind', 'path', 'line', 'signature', 'id']))
    .optional()
    .describe(
      '(name/exact only) Restrict compact rows to a subset of fields; only effective with `compact: true`. Default: name|kind|path|line|signature (plus `id` when a refId cache is active).',
    ),
  projectPath: projectPathField,
});

type FindArgs = z.infer<typeof findSchema>;

// ---------------------------------------------------------------------------
// Per-axis forwarders
// ---------------------------------------------------------------------------

/** Forward args to `handleFindByName` — strip the `by` axis discriminator. */
function forwardNameArgs(args: FindArgs): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  delete out['by'];
  // `pathFilter` IS honoured by `mode: 'intent'` — pass through unchanged.
  // Strip the axis-foreign knobs that name-search doesn't read.
  delete out['caseSensitive']; // grep-only
  delete out['op']; // sql-only
  delete out['key']; // env / sql only
  return out;
}

/** Forward args to `handleFindByContent` — rewrite `query` → `pattern` and strip axis-foreign knobs. */
function forwardContentArgs(args: FindArgs): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  delete out['by'];
  // `_grep` reads `args['pattern']`. The merged tool names this `query`
  // for vocabulary consistency with `by:'name'`. Rewrite at the boundary
  // so the backend stays unchanged.
  if (typeof args.query === 'string' && out['pattern'] === undefined) {
    out['pattern'] = args.query;
  }
  delete out['query'];
  delete out['mode']; // name-only
  delete out['kind']; // name-only
  delete out['symbol']; // name-only (semantic)
  delete out['sameLanguage']; // name-only (semantic)
  delete out['differentLanguage'];
  delete out['languageFilter'];
  delete out['fields']; // name-only projection
  delete out['compact']; // name-only projection
  delete out['key']; // env / sql only
  delete out['op']; // sql only
  delete out['includeTests']; // env / sql only
  return out;
}

/** Forward args to the env / sql handlers — strip axis-foreign knobs. */
function forwardRefsArgs(args: FindArgs): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  delete out['by'];
  delete out['query']; // axis sets handle no query
  delete out['mode'];
  delete out['kind'];
  delete out['symbol'];
  delete out['sameLanguage'];
  delete out['differentLanguage'];
  delete out['languageFilter'];
  delete out['fields'];
  delete out['compact'];
  delete out['caseSensitive'];
  delete out['pathFilter'];
  delete out['language'];
  delete out['since']; // env / sql don't carry delta-mode UIDs
  return out;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Reject `mode` when `by:` isn't 'name'. The schema validator can't
 * express conditional-by-discriminator constraints, so we enforce
 * here. Silent-ignore would set a footgun: an agent who passes
 * `mode:'fuzzy'` with `by:'content'` expects fuzzy regex (which
 * doesn't exist) and gets exact regex instead.
 */
function rejectIncompatibleMode(by: FindAxis, args: FindArgs): ToolOutcome | null {
  if (by === 'name') return null;
  if (args.mode === undefined) return null;
  return err(
    `cartograph_find: \`mode\` is only valid with \`by: 'name'\` (selects search mode: ` +
      `exact / fuzzy / semantic / intent). Drop \`mode\` or switch to \`by: 'name'\`.`,
  );
}

// Reject knobs that require `by: 'content'`.
function rejectContentOnlyKnobs(by: FindAxis, args: FindArgs): ToolOutcome | null {
  if (by === 'content') return null;
  if (args.caseSensitive !== undefined) {
    return err(`cartograph_find: \`caseSensitive\` is only valid with \`by: 'content'\` (regex content search).`);
  }
  if (args.language !== undefined) {
    return err(
      `cartograph_find: \`language\` is only valid with \`by: 'content'\`. Use \`languageFilter\` for semantic mode.`,
    );
  }
  return null;
}

// Reject knobs scoped to `by: 'env'` / `by: 'sql'`, plus the inverse
// `pathFilter` rejection on those axes.
function rejectEnvSqlOnlyKnobs(by: FindAxis, args: FindArgs): ToolOutcome | null {
  const isEnvOrSql = by === 'env' || by === 'sql';
  if (!isEnvOrSql && args.key !== undefined) {
    return err(
      `cartograph_find: \`key\` is only valid with \`by: 'env'\` (env-var name) or \`by: 'sql'\` (table name). ` +
        `For finding a symbol by name use \`by: 'name'\` with \`query\`.`,
    );
  }
  if (by !== 'sql' && args.op !== undefined) {
    return err(`cartograph_find: \`op\` is only valid with \`by: 'sql'\`.`);
  }
  if (!isEnvOrSql && args.includeTests !== undefined) {
    return err(`cartograph_find: \`includeTests\` is only valid with \`by: 'env'\` / \`by: 'sql'\`.`);
  }
  if (isEnvOrSql && args.pathFilter !== undefined) {
    return err(
      `cartograph_find: \`pathFilter\` is not honoured for \`by: '${by}'\`. ` +
        `Use \`by: 'content'\` or \`by: 'name', mode: 'intent'\` for path-scoped queries.`,
    );
  }
  return null;
}

// Reject knobs that require `by: 'name'`.
function rejectNameOnlyKnobs(by: FindAxis, args: FindArgs): ToolOutcome | null {
  if (by === 'name') return null;
  if (args.kind !== undefined) {
    return err(`cartograph_find: \`kind\` is only valid with \`by: 'name'\` (filter symbol kind).`);
  }
  if (args.symbol !== undefined) {
    return err(
      `cartograph_find: \`symbol\` is only valid with \`by: 'name', mode: 'semantic'\` (source symbol to find peers of).`,
    );
  }
  if (args.sameLanguage !== undefined) {
    return err(`cartograph_find: \`sameLanguage\` is only valid with \`by: 'name', mode: 'semantic'\`.`);
  }
  if (args.differentLanguage !== undefined) {
    return err(`cartograph_find: \`differentLanguage\` is only valid with \`by: 'name', mode: 'semantic'\`.`);
  }
  if (args.languageFilter !== undefined) {
    return err(`cartograph_find: \`languageFilter\` is only valid with \`by: 'name', mode: 'semantic'\`.`);
  }
  if (args.compact !== undefined) {
    return err(`cartograph_find: \`compact\` is only valid with \`by: 'name', mode: 'exact'\`.`);
  }
  if (args.fields !== undefined) {
    return err(
      `cartograph_find: \`fields\` is only valid with \`by: 'name', mode: 'exact'\` (paired with \`compact\`).`,
    );
  }
  return null;
}

// Reject `by: 'name'` knobs that are mode-specific. Effective mode is
// 'exact' when omitted (the schema's documented default).
function rejectNameModeMismatches(by: FindAxis, args: FindArgs): ToolOutcome | null {
  if (by !== 'name') return null;
  const effectiveMode = args.mode ?? 'exact';
  if (effectiveMode !== 'semantic') {
    if (args.symbol !== undefined) {
      return err(`cartograph_find: \`symbol\` requires \`mode: 'semantic'\`. Got mode='${effectiveMode}'.`);
    }
    if (args.sameLanguage !== undefined || args.differentLanguage !== undefined || args.languageFilter !== undefined) {
      return err(
        `cartograph_find: language-filter args (\`sameLanguage\` / \`differentLanguage\` / \`languageFilter\`) require \`mode: 'semantic'\`. ` +
          `Got mode='${effectiveMode}'.`,
      );
    }
  }
  if (effectiveMode !== 'exact' && (args.compact !== undefined || args.fields !== undefined)) {
    return err(`cartograph_find: \`compact\` / \`fields\` require \`mode: 'exact'\`. Got mode='${effectiveMode}'.`);
  }
  if (effectiveMode === 'semantic' && args.kind !== undefined) {
    return err(`cartograph_find: \`kind\` is not honoured with \`mode: 'semantic'\`. Drop \`kind\` or switch modes.`);
  }
  if ((effectiveMode === 'semantic' || effectiveMode === 'fuzzy') && args.pathFilter !== undefined) {
    return err(
      `cartograph_find: \`pathFilter\` is not honoured with \`mode: '${effectiveMode}'\`. Use \`mode: 'exact'\` or \`mode: 'intent'\`.`,
    );
  }
  return null;
}

// Reject empty-string / empty-array sentinels that look like caller
// bugs (the caller almost certainly wanted the default — omit the
// field — not the empty value).
function rejectSentinelValues(by: FindAxis, args: FindArgs): ToolOutcome | null {
  if (Array.isArray(args.fields) && args.fields.length === 0) {
    return err(
      `cartograph_find: \`fields\` must contain at least one entry. Omit the field to get the default column set.`,
    );
  }
  if (Array.isArray(args.fields) && args.fields.length > 0 && !args.fields.includes('name')) {
    const fieldList = args.fields.map((f) => `'${f}'`).join(', ');
    return err(
      `cartograph_find: \`fields\` must include 'name' so rows are identifiable. Got fields=[${fieldList}].`,
    );
  }
  if ((by === 'env' || by === 'sql') && typeof args.key === 'string' && args.key.length === 0) {
    return err(`cartograph_find: \`key\` must be a non-empty string (or omit it for the top-N listing).`);
  }
  return null;
}

/**
 * Reject axis-incompatible knobs with a discoverable message.
 *
 * Structural fix B (lite, 2026-05-19): the original rejection covered
 * only `caseSensitive` / `key` / `op` — the rest of the axis-foreign
 * args silently dropped when passed to the wrong `by` / `mode`
 * combination (Friction #20). This pass covers the full matrix.
 *
 * Why not Zod `discriminatedUnion`: the proper fix would model each
 * `by` branch as its own object and let Zod itself enforce the
 * per-branch field whitelist, but `defineTool` currently binds
 * `ToolZodSchema` to `z.ZodObject` and consumes a single `properties`
 * map for the published JSON-Schema. A discriminated union would
 * widen both contracts and produce a `oneOf`-shaped `inputSchema`
 * that not every MCP client renders intelligibly. This runtime-
 * rejection alternative ships the full enforcement at the cost of
 * one cross-field check pass per call. See deferred task "Structural
 * fix B (full): discriminated unions on cartograph_find" for the
 * eventual refactor.
 */
function rejectIncompatibleKnobs(by: FindAxis, args: FindArgs): ToolOutcome | null {
  return (
    rejectContentOnlyKnobs(by, args) ??
    rejectEnvSqlOnlyKnobs(by, args) ??
    rejectNameOnlyKnobs(by, args) ??
    rejectNameModeMismatches(by, args) ??
    rejectSentinelValues(by, args)
  );
}

async function handleFind(ctx: ToolCtx, args: FindArgs): Promise<ToolOutcome> {
  // `by` is a required `z.enum` — `safeParse` already rejected a
  // missing / unknown value (and the `.superRefine` adds the
  // sibling-mode redirect), so the axis is a known `FindAxis` here.
  const by = args.by as FindAxis;

  // ── Per-axis validation ──────────────────────────────────────────
  // `mode`'s enum membership is validated by the schema; only the
  // axis-compatibility cross-field rule remains in the handler.
  const modeMismatch = rejectIncompatibleMode(by, args);
  if (modeMismatch) return modeMismatch;
  const knobMismatch = rejectIncompatibleKnobs(by, args);
  if (knobMismatch) return knobMismatch;

  // ── Query-required check ─────────────────────────────────────────
  // 'name' (mode='semantic' with `symbol` only) is the one path that
  // can skip `query`. Per-helper validation re-checks; we only enforce
  // here for the three deterministic axes whose backend doesn't have
  // a `symbol`-equivalent alt input.
  if (by === 'content') {
    // allowWhitespaceOnly: a pure-whitespace regex (`"  "`, `"\t"`) is a
    // valid grep pattern — it matches lines with that exact indentation.
    const q = validateStringOutcome({ value: args.query, name: 'query', maxLength: 4096, allowWhitespaceOnly: true });
    if (typeof q !== 'string') return q;
  } else if (by === 'name') {
    // Mode='semantic' allows EITHER `query` OR `symbol`. Other modes
    // require `query`. Delegate per-mode validation to `_search.ts`.
    // No top-level enforcement here — same as the pre-merge tool.
  }
  // by='env' / by='sql' don't require `query` — the `key` arg drives them.

  // ── Dispatch ─────────────────────────────────────────────────────
  // The `_search.ts` / `_grep.ts` / `_string_refs.ts` sub-handlers
  // return a typed `ToolOutcome` directly — the outcome propagates
  // with no `ok(...)` wrap.
  switch (by) {
    case 'name':
      return handleFindByName(ctx, forwardNameArgs(args));
    case 'content':
      return handleFindByContent(ctx, forwardContentArgs(args));
    case 'env':
      return handleFindByEnv(ctx, forwardRefsArgs(args));
    case 'sql':
      return handleFindBySql(ctx, forwardRefsArgs(args));
  }
}

// ---------------------------------------------------------------------------
// Tool module
// ---------------------------------------------------------------------------

export const FIND_TOOL = defineTool({
  name: 'cartograph_find',
  description:
    'Find a thing in the codebase — symbol by name, regex content, env-var reads, or SQL table refs, in one tool.\n\n' +
    "`by`: `'name'` (FTS / fuzzy / semantic / intent — pick via `mode`) | `'content'` (regex with enclosing-symbol attribution) | " +
    "`'env'` / `'sql'` (string-literal cross-references; `key` filters to one var/table). " +
    "`mode` is `by: 'name'` only; `caseSensitive` is `by: 'content'`; `key` is `by: 'env'|'sql'`; `op: read|write|ddl` is `by: 'sql'`. " +
    "On `by: 'name'`: `compact` + `fields` give terse rows; `since: 'c_xxxxxxxx'` gives new-only rows vs a prior call (mode='exact'). " +
    'Multi-word bare-identifier queries under mode=\'exact\' route to an "Exact match union" view (per-token group), not an empty FTS-AND; `Foo OR Bar` auto-recovers to that view (FTS5 boolean operators stripped, with a one-line note).',
  schema: findSchema,
  handle: handleFind,
});
