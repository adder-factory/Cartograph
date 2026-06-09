/**
 * cartograph_graph — unified graph-navigation tool.
 *
 * The 2026-05-11 four-tool merge collapsed `cartograph_callers`,
 * `cartograph_callees`, `cartograph_walk`, and `cartograph_impact` into
 * one entry point. The agent picks the slice via `direction` +
 * `hops`; per-direction helpers in the `_callers.ts` / `_callees.ts`
 * / `_walk.ts` / `_impact.ts` private modules preserve every
 * behavior the four originals shipped (edge-kind defaulting,
 * type-user merge for type-like sources, container-method hint on
 * empty callees, multi-hop BFS with container `contains`
 * auto-include, per-source breakdown on ambiguous impact, all
 * compact / fields / since / includeRoles / minConfidence flags).
 *
 * Dispatch matrix:
 *
 *   direction='callers',  hops=1            → handleCallers
 *   direction='callees',  hops=1            → handleCallees
 *   direction='impact'|'both', hops=1 or 2  → handleImpact (when rich
 *     per-file rollup is the right output)
 *   any direction,        hops > 1          → handleWalk (BFS)
 *
 * The dispatcher reshapes the `{start, hops, …}` graph args into each
 * helper's native arg bag before delegation. The helpers' public
 * surface (`handle*`) is preserved verbatim so the merge is a thin
 * argument-routing layer, not a re-implementation.
 *
 * NOTE on `since`: the `c_xxxxxxxx` delta-mode UIDs minted by the old
 * `cartograph_callers` / `cartograph_callees` are scoped to their tool
 * name in the call-id cache. UIDs minted before this merge will not
 * resolve under `cartograph_graph` — the response just falls back to a
 * full result with the standard "call id is no longer cached" warning.
 * Acceptable for an API-break refactor.
 *
 * SCHEMA SHAPE (structural campaign P4 wave 2 — `defineTool`/Zod).
 * `graph` is a FAMILY tool with a `direction` discriminator. The Zod
 * schema is a FLAT `z.object` — `direction` is a `z.enum`, every
 * per-direction field is `.optional()`, mirroring the union-of-all
 * shape the hand-written JSON `inputSchema` always had. A strict
 * `z.discriminatedUnion` would newly reject calls valid today; out of
 * scope. Numeric fields carry their documented bounds via
 * `.int().min().max()` — out-of-range values are REJECTED at the
 * dispatch boundary (locked decision), so the BFS / impact helpers'
 * own `clamp` calls become dead defence-in-depth. Cross-field rules
 * (start⇄symbols mutual exclusion, BFS engagement) stay in the
 * handler verbatim.
 */

import { z } from 'zod';
import { lowTokensField, projectPathField, batchedSymbols } from './_common-fields.js';
import { validateStringOutcome } from './shared.js';
import type { ToolCtx } from './types.js';
import type { RefIdCache } from './_id-cache.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { parseStrictDecimalInteger } from '../../strict-numeric.js';

import { CALLERS_MAX_SYMBOLS, handleCallers } from './_callers.js';
import { handleCallees } from './_callees.js';
import { handleImpact } from './_impact.js';
import { handlePath } from './_path.js';
import { handleSimilar } from './similar.js';
import {
  WALK_MAX_HOPS,
  WALK_DEFAULT_MAX_NODES,
  WALK_MAX_MAX_NODES,
  WALK_VALID_EDGE_KINDS,
  handleWalk,
} from './_walk.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Public-facing direction values. `'both'` is a friendly alias for
 *  `'impact'`. `'similar'` is the embedding-cosine peer mode that was
 *  previously a standalone `cartograph_similar` tool (folded in
 *  2026-05-14 to free a slot against the 45-tool registry cap;
 *  FRICTION-46). */
type GraphDirection = 'callers' | 'callees' | 'impact' | 'both' | 'similar' | 'path';

/** Edge-kind enum reused from the BFS module (single source of truth). */
const VALID_EDGE_KINDS = WALK_VALID_EDGE_KINDS;

/** Top-K ceiling (50) for `cartograph_graph`'s `direction: similar`.
 *  The sibling `minScore` knob is a 0..1 float, not an int. */
const SIMILAR_MAX_K = 50;

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

/**
 * Flat Zod schema for `cartograph_graph`. Field names, enum values, and
 * `.describe()` text are copied verbatim from the pre-migration
 * hand-written JSON `inputSchema`; every per-direction field is
 * `.optional()` so the schema accepts the same arg union the legacy
 * tool did.
 *
 * `hops` is `.int().min(1).max(WALK_MAX_HOPS).default(1)` — `hops: 0`
 * (legacy: clamped up to 1) is now REJECTED. `maxNodes`, `limit`, `k`
 * carry their `.int()` ranges; `minScore` is a `.min(0).max(1)` float.
 * The BFS / impact / similar helpers still `clamp` defensively, but
 * `safeParse` rejects out-of-range values before any helper runs.
 */
const graphSchema = z.object({
  start: z
    .string()
    .optional()
    .describe(
      'Symbol name (or short `n_xxxxxxxx` UID from a prior result) to start from. Mutually exclusive with `symbols`.',
    ),
  to: z
    .string()
    .optional()
    .describe('(direction=path) Target symbol for the shortest `start`→target path. Name or `n_xxxxxxxx` UID.'),
  symbols: batchedSymbols
    .optional()
    .describe(
      `Multi-symbol form (mutually exclusive with \`start\`): up to ${CALLERS_MAX_SYMBOLS} names or \`n_xxxxxxxx\` UIDs. ` +
        'Use with `direction: callers | callees` at `hops: 1`, or with `direction: similar`; over-cap inputs are rejected (no silent truncation).',
    ),
  direction: z
    .enum(['callers', 'callees', 'impact', 'both', 'similar', 'path'])
    .describe(
      '`callers` — incoming edges (who calls/type-uses start). ' +
        '`callees` — outgoing edges (what start calls). ' +
        '`impact` — symmetric blast radius (per-file rollup + per-source breakdown). ' +
        '`both` — alias for `impact`. ' +
        '`similar` — embedding-cosine peers of `start`, grouped per source with cosine `score` (persisted `similar_to` edges first, else on-demand vec0 KNN). ' +
        '`path` — shortest `start`→`to` route (how does X reach Y; all edge kinds by default — set `edgeKind: calls` for a call-flow-only path). ' +
        'With `hops > 1`, callers/callees/impact run BFS in that orientation (path/similar ignore hops).',
    ),
  hops: z
    .number()
    .int()
    .min(1)
    .max(WALK_MAX_HOPS)
    .default(1)
    .describe(
      `Default 1 — one-hop slice. Values > 1 (max ${WALK_MAX_HOPS}) switch to BFS with depth + via-parent annotations ` +
        `per row. For \`direction: impact\` / \`both\`, hops is the impact traversal depth. Out-of-range values are rejected.`,
    ),
  // `.optional()` with NO `.default()`: the dispatcher's
  // walk-engagement test must distinguish "caller explicitly passed
  // maxNodes" (→ route to BFS even at hops=1) from "omitted". A Zod
  // `.default()` would erase that signal. `_walk.ts` applies the
  // `WALK_DEFAULT_MAX_NODES` default itself via `numArg`.
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(WALK_MAX_MAX_NODES)
    .optional()
    .describe(
      `BFS-only (hops > 1). Max nodes returned. Range 1-${WALK_MAX_MAX_NODES}, default ${WALK_DEFAULT_MAX_NODES}. Out-of-range rejected.`,
    ),
  edgeKind: z
    .enum([...VALID_EDGE_KINDS] as [string, ...string[]])
    .optional()
    .describe(
      'Filter by edge kind: `calls`, `instantiates`, `references`, `type_of`, `returns`, `extends`, `implements`, ' +
        '`overrides`, `decorates`, `imports`, `contains` (parent→child), `exports`, `tests`, `field_access`, ' +
        '`similar_to` (opt-in), `def_use` (opt-in). ' +
        'When unset on `direction: callers`, type-usage edges are merged in alongside `calls` for type-like sources. ' +
        'When unset on multi-hop (`hops > 1`) walks against a container kind on `direction: callees | impact | both`, ' +
        "`contains` is auto-included so one call lists the container's members.",
    ),
  // `.optional()` with NO `.default()` — same reason as `maxNodes`:
  // an explicit `rankBy` is a walk-engagement signal the dispatcher
  // must see. `_walk.ts` defaults it to `bfs` itself.
  rankBy: z
    .enum(['bfs', 'centrality'])
    .optional()
    .describe(
      'BFS-only (hops > 1). `bfs` (default) keeps first-seen BFS order. ' +
        '`centrality` sorts the visited set by PageRank descending (NULL last) before truncating to maxNodes.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      'One-hop (`hops: 1`) callers/callees: max rows to return (default 20, max 100). ' +
        'Ignored on `direction: impact | both` and on `hops > 1` BFS walks (use `maxNodes`). Out-of-range rejected.',
    ),
  minConfidence: z
    .enum(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
    .optional()
    .describe(
      "Drop edges below this confidence. 'EXTRACTED' = concrete-only (imports/qualified names/file-paths). " +
        "'INFERRED' = also keep heuristic same-name + framework-rule matches. 'AMBIGUOUS' = no-op (everything passes). " +
        'Honoured on one-hop callers/callees/impact; ignored on BFS walks (`hops > 1`).',
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Emit terse pipe-delimited `name|kind|path:line[|id:n_xxxxxxxx]` rows instead of markdown bullets. ' +
        'Default false for one-hop callers/callees, true on BFS walks (`hops > 1`). Ignored on `direction: impact | both`.',
    ),
  fields: z
    .array(z.enum(['name', 'kind', 'path', 'line', 'id', 'role']))
    .optional()
    .describe(
      'Restrict compact rows to a subset of fields (only effective with `compact: true`). ' +
        'Default: all five fields plus `role` when `includeRoles: true`. Honoured on one-hop callers/callees only.',
    ),
  since: z
    .string()
    .optional()
    .describe(
      'Delta mode — pass a `c_xxxxxxxx` UID from a prior call to return only rows absent from that prior result. ' +
        'The footer carries a fresh `> _call: c_xxxxxxxx_` marker so the chain continues; unknown UIDs fall back to the ' +
        'full result with a warning. Honoured on one-hop callers/callees only.',
    ),
  includeRoles: z
    .boolean()
    .optional()
    .describe(
      "Inline each row's `nodes.role` value (e.g. `business_logic`, `api_endpoint`, `util`). " +
        'Honoured on one-hop callers/callees and on BFS walks (`hops > 1`). NULL-role rows render no role column.',
    ),
  includeTests: z
    .boolean()
    .optional()
    .describe(
      'When false, drop test-file targets (`__tests__/`, `*.test.*`, `*.spec.*`, etc.) from BFS expansion AND the result ' +
        'set on multi-hop walks (`hops > 1`). Default `true` for one-hop `direction: callers | callees`, `false` for ' +
        '`hops > 1` BFS walks. When the START symbol is itself in a test file, test-file traversal stays on regardless.',
    ),
  lowTokens: lowTokensField,
  // ── Similar-only knobs (direction: 'similar' only) ─────────────────
  // Folded in 2026-05-14 (FRICTION-46) when the standalone
  // cartograph_similar tool was retired. Ignored for other directions;
  // the similar handler reads them directly.
  k: z
    .number()
    .int()
    .min(1)
    .max(SIMILAR_MAX_K)
    .optional()
    .describe(
      `(direction=similar) Top-K neighbours per source (default 5, max ${SIMILAR_MAX_K}). Out-of-range rejected.`,
    ),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      '(direction=similar) Minimum cosine similarity to surface (0..1). Default 0.3 — permissive for useful breadth.',
    ),
  sameLanguage: z
    .boolean()
    .optional()
    .describe('(direction=similar) When true, restrict matches to the same language as each source. Default false.'),
  projectPath: projectPathField,
});

type GraphArgs = z.infer<typeof graphSchema>;
type GraphCompactField = NonNullable<GraphArgs['fields']>[number];

const LOW_TOKEN_GRAPH_FIELDS: GraphCompactField[] = ['name', 'kind', 'path', 'line', 'id'];
const LOW_TOKEN_GRAPH_LIMIT = 10;
const LOW_TOKEN_WALK_MAX_NODES = 20;
const LOW_TOKEN_SIMILAR_K = 5;

function applyGraphLowTokens(args: GraphArgs): GraphArgs {
  if (args.lowTokens !== true) return args;

  const out: GraphArgs = { ...args };
  if (out.limit > LOW_TOKEN_GRAPH_LIMIT) {
    out.limit = LOW_TOKEN_GRAPH_LIMIT;
  }
  if ((out.direction === 'callers' || out.direction === 'callees') && out.compact !== false) {
    out.compact = true;
    out.fields ??= LOW_TOKEN_GRAPH_FIELDS;
  }
  if (out.direction === 'similar' && out.k !== undefined && out.k > LOW_TOKEN_SIMILAR_K) {
    out.k = LOW_TOKEN_SIMILAR_K;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Map the unified `cartograph_graph` arg bag onto the callers / callees
 * helpers' native shape.  Both helpers expect `symbol` / `symbols` (not the
 * unified tool's `start`) and don't accept `hops`, `direction`, `rankBy`, or
 * `maxNodes` — strip those keys and rename `start` → `symbol` when needed.
 * The two helpers are structurally identical so they share this forwarder.
 */
function forwardCallersOrCalleesArgs(args: GraphArgs): Record<string, unknown> {
  // _callers / _callees expect `symbol` / `symbols`; this tool's primary
  // input is `start`. Pass either form through unchanged so the batched /
  // single dispatch inside those helpers fires correctly.
  const out: Record<string, unknown> = { ...args };
  if (args.start !== undefined && out['symbol'] === undefined && out['symbols'] === undefined) {
    out['symbol'] = args.start;
  }
  // `hops` / `direction` aren't part of the callers/callees schema — strip
  // them so they don't pollute downstream validation.
  delete out['hops'];
  delete out['direction'];
  delete out['rankBy'];
  delete out['maxNodes'];
  delete out['start'];
  delete out['lowTokens'];
  return out;
}

function forwardImpactArgs(args: GraphArgs): Record<string, unknown> {
  // _impact expects `symbol` + `depth`. Map `start` → `symbol`,
  // `hops` → `depth`. The impact helper clamps depth to 1-5 (matching
  // the documented `hops` cap), so a hops=1 graph call still produces
  // a valid one-hop blast-radius answer.
  const out: Record<string, unknown> = { ...args };
  if (args.start !== undefined && out['symbol'] === undefined) {
    out['symbol'] = args.start;
  }
  if (args.hops !== undefined && out['depth'] === undefined) {
    out['depth'] = args.hops;
  }
  delete out['hops'];
  delete out['direction'];
  delete out['rankBy'];
  delete out['maxNodes'];
  delete out['compact'];
  delete out['fields'];
  delete out['since'];
  delete out['includeRoles'];
  delete out['symbols'];
  delete out['start'];
  delete out['lowTokens'];
  return out;
}

function forwardWalkArgs(args: GraphArgs): Record<string, unknown> {
  // _walk's native shape — pass through. `start` and `direction` are
  // already the right names; `hops` / `maxNodes` / `rankBy` /
  // `edgeKind` / `compact` / `includeRoles` are all walk-native.
  // `symbol(s)` aren't walk-native so strip them; `since` / `fields` /
  // `minConfidence` aren't walk-native either — drop with a footer
  // warning in the dispatcher when set with hops > 1.
  const out: Record<string, unknown> = { ...args };
  delete out['symbol'];
  delete out['symbols'];
  delete out['since'];
  delete out['fields'];
  delete out['minConfidence'];
  delete out['lowTokens'];
  return out;
}

// ---------------------------------------------------------------------------
// Impact "wide blast radius" warning normalisation
// ---------------------------------------------------------------------------

/**
 * Default impact traversal depth used by `_impact.ts` when no `depth`
 * is forwarded — kept in sync with `clamp(numArg(args['depth'], 1), …)`
 * there. Matches the `hops` schema's stated `Default 1` and the CLI's
 * `--hops` default so an impact call with no explicit hops behaves the
 * same on the MCP and CLI surfaces. The dispatcher needs it to know the
 * *effective* depth of an impact call that didn't pass `hops`, so the
 * "lower hops" advice can be suppressed only when the depth is
 * genuinely already minimal.
 */
const IMPACT_DEFAULT_DEPTH = 1;

/**
 * Match the "lower `hops` (try 1), or " clause inside the impact
 * handler's "Wide blast radius" warning. The trailing `, or ` is part
 * of the capture so removing the clause leaves a grammatical
 * "Consider narrowing: pick a more specific symbol." sentence.
 */
const IMPACT_HOPS_ADVICE_RE = /lower `hops` \(try 1\), or /;

/**
 * Strip the "lower `hops` (try 1)" advice from the impact handler's
 * wide-blast-radius warning when the effective traversal depth is
 * already 1 — at minimal depth that advice is a no-op and misleads the
 * agent into a non-fix (friction #18, audit group 1 #7). `_impact.ts`
 * renders the warning without knowing the depth, so the dispatcher —
 * which DOES know it — rewrites the line here. Depths > 1 keep the
 * advice verbatim. Non-impact output is never touched (the regex can
 * only match the impact warning string).
 * @internal — exported for unit tests; not part of the public surface.
 */
export function normaliseImpactHopsAdvice(text: string, effectiveDepth: number): string {
  if (effectiveDepth > 1) return text;
  return text.replace(IMPACT_HOPS_ADVICE_RE, '');
}

/**
 * Coerce a raw `hops` value to a finite integer, defaulting to
 * {@link IMPACT_DEFAULT_DEPTH}. Accepts a number or a numeric string —
 * Zod's `.default(1)` means a parsed call always carries a number, but
 * the exported `effectiveImpactDepth` is also called directly from
 * unit tests with raw (string-bearing) arg bags, so the coercion is
 * retained.
 */
function coerceHops(hopsRaw: unknown): number {
  if (typeof hopsRaw === 'number' && Number.isFinite(hopsRaw)) return hopsRaw;
  if (typeof hopsRaw === 'string') {
    const n = parseStrictDecimalInteger(hopsRaw);
    if (n !== null) return n;
  }
  return IMPACT_DEFAULT_DEPTH;
}

/**
 * Resolve the effective impact traversal depth for a `direction:
 * impact | both` call. Mirrors `forwardImpactArgs` + `_impact.ts`'s
 * own default: when `hops` is passed it becomes the depth, otherwise
 * `_impact.ts` falls back to {@link IMPACT_DEFAULT_DEPTH}.
 * @internal — exported for unit tests; not part of the public surface.
 */
export function effectiveImpactDepth(args: { hops?: unknown }): number {
  return args.hops === undefined ? IMPACT_DEFAULT_DEPTH : coerceHops(args.hops);
}

/**
 * Run the impact handler and post-process its text so the
 * wide-blast-radius warning's "lower hops" advice is suppressed at
 * minimal depth (see {@link normaliseImpactHopsAdvice}). Error
 * envelopes pass through untouched.
 */
async function runImpact(ctx: ToolCtx, args: GraphArgs): Promise<ToolOutcome> {
  const depth = effectiveImpactDepth(args);
  const outcome = await handleImpact(ctx, forwardImpactArgs(args));
  if (!outcome.ok) return outcome;
  const rewritten = outcome.value.content.map((part) =>
    part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: normaliseImpactHopsAdvice(part.text, depth) }
      : part,
  );
  return ok({ ...outcome.value, content: rewritten });
}

// ---------------------------------------------------------------------------
// BFS UID normalisation
// ---------------------------------------------------------------------------

/**
 * Match a raw node id rendered as `id:<kind>:<32-hex-hash>` in BFS-walk
 * output (both the compact `|id:…` column and the markdown `` `id:…` ``
 * suffix). Node ids are minted by `generateNodeId` as `<kind>:<32 hex
 * chars>` — see `src/extraction/tree-sitter-helpers.ts`. The capture
 * group is the full raw id so it can be re-minted to a short UID.
 */
const BFS_RAW_ID_RE = /id:([a-z_]+:[0-9a-f]{32})/g;

/**
 * The BFS walker (`_walk.ts`) renders each row's node id verbatim as a
 * long `id:function:3018a910…` token. One-hop callers/callees rows mint
 * the short `n_xxxxxxxx` form via `ctx.refIds` instead — a long raw id
 * costs ~3× the chars and, more importantly, cannot be chained back as
 * `start:` (the dispatcher only recognises `n_` UIDs and full names).
 *
 * This post-processes the walker's output so multi-hop BFS rows carry
 * the SAME short UID form as one-hop rows. Each raw id is run through
 * `refIds.mint` — the same cache one-hop rows use — so the minted UID
 * resolves on a follow-up call. (FRICTION — BFS/one-hop UID mismatch.)
 */
function normaliseBfsRowIds(text: string, refIds: RefIdCache): string {
  return text.replaceAll(BFS_RAW_ID_RE, (_match, rawId: string) => `id:${refIds.mint(rawId)}`);
}

/**
 * BFS-walk dispatch for `direction: callers | callees` when the caller
 * wants multi-hop semantics — invoked from {@link handleGraph} once it
 * has decided (hops > 1, or walk-only args like `rankBy` / `maxNodes`).
 *
 * Defaults `includeTests` off: test-file consumers of intermediate
 * callees are structural noise on a "what does X transitively call"
 * walk. One-hop callers/callees keep the pre-merge unconditional-edge
 * behaviour; the walker itself flips tests back on when the start node
 * is a test. After the walk, the walker's long raw `id:<kind>:<hash>`
 * tokens are rewritten into the short `n_xxxxxxxx` UID form one-hop
 * rows already emit, so multi-hop BFS rows stay chainable as `start:`.
 * Error envelopes pass through untouched.
 */
async function runBfsWalk(ctx: ToolCtx, args: GraphArgs): Promise<ToolOutcome> {
  const walkArgs = forwardWalkArgs(args);
  if (walkArgs['includeTests'] === undefined) {
    walkArgs['includeTests'] = false;
  }
  if (args.lowTokens === true && walkArgs['maxNodes'] === undefined) {
    walkArgs['maxNodes'] = LOW_TOKEN_WALK_MAX_NODES;
  }
  const outcome = await handleWalk(ctx, walkArgs);
  if (!outcome.ok) return outcome;
  const rewritten = outcome.value.content.map((part) =>
    part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: normaliseBfsRowIds(part.text, ctx.refIds) }
      : part,
  );
  return ok({ ...outcome.value, content: rewritten });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleGraph(ctx: ToolCtx, args: GraphArgs): Promise<ToolOutcome> {
  args = applyGraphLowTokens(args);
  // `direction` is a required `z.enum` and `hops` carries a `.default(1)`,
  // so `safeParse` already supplied / validated both.
  const direction = args.direction as GraphDirection;
  const hops = args.hops;

  const validation = validateGraphDispatchArgs(args, direction, hops);
  if (validation) return validation;

  // ── direction='impact'/'both' always uses the impact formatter ───
  // The impact path produces a per-file concentration rollup +
  // per-source breakdown that's substantively different from BFS-walk
  // output (no depth/via-parent rows). It already runs its own
  // transitive traversal internally via `getImpactRadius(depth)`, so
  // `hops` is forwarded as the depth and the dispatcher does NOT
  // hand off to the BFS walker for impact even at hops > 1. This
  // preserves the pre-merge `_impact({depth: N})` semantics verbatim.
  // `runImpact` delegates to the `_impact.ts` sub-handler, which
  // returns a typed `ToolOutcome` directly — no `ok(...)` wrap.
  if (direction === 'impact' || direction === 'both') {
    return runImpact(ctx, args);
  }

  // ── direction='similar' — embedding-cosine peers ─────────────────
  // Folded in 2026-05-14 (FRICTION-46). The handler retains its
  // grouped-per-source output shape with explicit cosine `score` per
  // hit — that data is the whole point of the mode. Translate `start`
  // → `symbol` so the graph-shaped public surface matches the rest of
  // the tool; pass-through `symbols`, `k`, `minScore`, `sameLanguage`
  // unchanged.
  if (direction === 'similar') {
    const similarArgs: Record<string, unknown> = { ...args };
    if (similarArgs['start'] !== undefined && similarArgs['symbol'] === undefined) {
      similarArgs['symbol'] = similarArgs['start'];
    }
    delete similarArgs['lowTokens'];
    return handleSimilar(ctx, similarArgs);
  }

  // ── direction='path' — shortest X→Y dependency path ──────────────
  // Wraps the existing GraphTraverser.findPath BFS. Single start + single
  // `to` (no `symbols` batch, no `hops`/BFS-walk engagement); the handler
  // resolves both endpoints and renders the node→edge chain. `to` is
  // required here — the handler returns a typed error if it's missing.
  if (direction === 'path') {
    return handlePath(ctx, { start: args.start, to: args.to, edgeKind: args.edgeKind, projectPath: args.projectPath });
  }

  // ── BFS engagement (callers / callees only) ──────────────────────
  // For `direction: callers | callees`, the agent gets BFS-walk
  // semantics (depth + via-parent annotations, `Walk from <X>` header,
  // `rankBy: 'centrality'` ordering, container `contains` auto-include)
  // when ANY of these holds:
  //   - hops > 1 (genuinely multi-hop investigation)
  //   - the caller passed walk-only args (`rankBy` / `maxNodes`) which
  //     have no meaning outside BFS — interpret as "I want the walker".
  // Otherwise (hops=1 default and no walk-only args) the rich one-hop
  // formats from the pre-merge `_callers` / `_callees` tools handle
  // the dispatch.
  //
  // `rankBy` / `maxNodes` are declared `.optional()` with NO Zod
  // `.default()` precisely so this check stays honest: ANY explicit
  // value (even the would-be default) is a "give me the walker"
  // signal — verbatim with the pre-migration behaviour.
  const walkOnlyArgs = args.rankBy !== undefined || args.maxNodes !== undefined;
  if (hops > 1 || walkOnlyArgs) {
    return runBfsWalk(ctx, args);
  }

  // ── One-hop, direction='callers' ─────────────────────────────────
  // Preserves the old `_callers` behavior: incoming `calls` edges by
  // default plus type-user edges merged in for type-like sources;
  // batched `symbols: [...]`; `compact` / `fields` / `since` /
  // `includeRoles` / `minConfidence`. The `_callers.ts` / `_callees.ts`
  // sub-handlers return a typed `ToolOutcome` directly.
  if (direction === 'callers') {
    return handleCallers(ctx, forwardCallersOrCalleesArgs(args));
  }

  // ── One-hop, direction='callees' ─────────────────────────────────
  // Preserves the old `_callees` behavior including container-method
  // hint on empty results.
  return handleCallees(ctx, forwardCallersOrCalleesArgs(args));
}

function validateGraphDispatchArgs(args: GraphArgs, direction: GraphDirection, hops: number): ToolOutcome | null {
  // Mutual-exclusivity check and `start` shape — the per-helper
  // handlers also re-validate `symbol` / `symbols` after the arg
  // forwarding step, but doing it here too keeps the error message
  // pinned to the public arg names (`start` / `symbols`) instead of
  // leaking the internal `symbol`. Skips when only `symbols` was
  // passed (start may legitimately be absent on the batched callers/
  // callees path).
  const startRaw = args.start;
  const symbolsRaw = args.symbols;
  if (startRaw !== undefined && symbolsRaw !== undefined) {
    return err('Cannot specify both `start` and `symbols`.');
  }
  if (symbolsRaw !== undefined) return validateGraphBatchArgs(args, direction, hops);
  const startVal = validateStringOutcome({ value: startRaw, name: 'start' });
  return typeof startVal === 'string' ? null : startVal;
}

function validateGraphBatchArgs(args: GraphArgs, direction: GraphDirection, hops: number): ToolOutcome | null {
  if (direction === 'similar') return null;
  if (direction !== 'callers' && direction !== 'callees') {
    return err('`symbols` is only supported with `direction: "callers"` or `direction: "callees"`.');
  }
  if (hops !== 1 || args.rankBy !== undefined || args.maxNodes !== undefined) {
    return err('`symbols` batch mode only supports one-hop callers/callees queries (`hops: 1`, no walk-only args).');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool module
// ---------------------------------------------------------------------------

export const GRAPH_TOOL = defineTool({
  name: 'cartograph_graph',
  description:
    // ≤120 char WHAT line + ≤6 line HOW body — two-tier shape (P6).
    'Navigate the call/dependency graph from a symbol — callers, callees, transitive impact, X→Y path, or multi-hop BFS in one tool.\n\n' +
    '`direction`: `callers` (incoming) | `callees` (outgoing) | `impact`/`both` (bidirectional blast radius) | `similar` | `path` (shortest `start`→`to` route). ' +
    '`hops`: 1 (default) = one-hop slice; >1 = BFS walk with depth + via-parent. ' +
    'Batched form: `symbols: [...]` up to 20 (callers/callees one-hop, or similar peers). ' +
    '`edgeKind` filters edges; `compact`/`fields`/`since`/`includeRoles`/`minConfidence`/`lowTokens` for token control. ' +
    'Multi-hop BFS (`hops > 1`) excludes test-file targets by default — pass `includeTests: true` to walk into them.',
  schema: graphSchema,
  handle: handleGraph,
  requiresFreshIndex: (args) => args['direction'] === 'impact' || args['direction'] === 'both',
});
