/**
 * Role classifier — assigns each symbol with a description (LLM
 * summary OR docstring) a coarse role from a fixed label set. Lets
 * callers filter "show me all api_endpoints" or "list the
 * data_models" without crawling the graph by hand.
 *
 * Tier-2 enrichment: small fixed-label output, cached on `nodes.role`
 * (post-migration 040 — was on `symbol_summaries.role` pre-040).
 * The cascade input lets the classifier run on un-summarised nodes
 * that nevertheless carry a JSDoc / docstring, lifting role coverage
 * by ~7% on the cartograph corpus at near-equivalent quality.
 *
 * The classifier runs BATCHED — N symbols per call. The call requests
 * grammar-constrained structured output (`BATCH_ROLE_SCHEMA` passed as
 * `ChatOptions.responseSchema`), so on the hard-constrained backends
 * (openai-compat json_schema / anthropic-api tool-use) every reply is a valid set of
 * role labels by construction. A symbol a reply omits — only the
 * soft-constrained claude-bridge path can produce one — defaults to
 * `unknown`, re-classifiable on a later pass. There is no per-item
 * LLM retry: a batch-level chat failure counts the batch as errored.
 */

import { type LlmClient, LlmEndpointError, BATCH_PARSE_FAILURE_LOG_CHARS, type ResponseJsonSchema } from './client.js';
import type { QueryBuilder } from '../db/queries.js';
import {
  getClassifiableNodes,
  upsertSymbolRole,
  getCallerCountMap,
  getFrameworkImportFiles,
  getSymbolNeighborhood,
} from '../db/queries-roles.js';
import { logDebug, logWarn } from '../errors.js';
import { compact } from '../utils.js';
import { isContextWindowError, withTransientLlmRetry } from './retry-policy.js';
import { z } from 'zod';

/** Closed label set. The model is asked to pick exactly one.
 *  Exported as the canonical role vocabulary. It moved out of the
 *  deleted `local-role-classifier.ts` (transformers.js NLI, removed
 *  2026-05-14). */
export const ROLE_LABELS = [
  'api_endpoint',
  'business_logic',
  'data_model',
  'util',
  'framework_glue',
  'test_helper',
  'unknown',
] as const;

export type RoleLabel = (typeof ROLE_LABELS)[number];

/**
 * Structured-output schema for a batched classify call. Object-rooted
 * (`{results: [...]}`) so it doubles as an Anthropic tool `input_schema`.
 * The `role` field is an `enum` over {@link ROLE_LABELS} — on the
 * grammar-constrained backends (openai-compat / anthropic-api) the model
 * CANNOT emit a non-label, so the response is a valid set of roles by
 * construction. Passed as `ChatOptions.responseSchema`.
 */
const BATCH_ROLE_SCHEMA: ResponseJsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          role: { enum: [...ROLE_LABELS] },
        },
        required: ['i', 'role'],
      },
    },
  },
  required: ['results'],
};

const DEFAULT_CONCURRENCY = 8;
/** Symbols per batched API call (50). Each output entry is ~30 chars
 *  (`{"i":42,"role":"business_logic"}`), so 50 fits comfortably under
 *  the 1500-token output cap. Input scales with summary length but
 *  stays well within Haiku's 200K context. */
const DEFAULT_BATCH_SIZE = 50;

/** Floor on the per-batch maxTokens budget — a single short JSON
 *  reply still fits in 64 tokens, so smaller batches don't get
 *  truncated. */
const MIN_BATCH_MAX_TOKENS = 64;
/** Approx tokens per batched output entry (12). Pairs with
 *  `MIN_BATCH_MAX_TOKENS` to size the chat call. */
const TOKENS_PER_BATCH_ENTRY = 12;
const ROLE_LIST_TEXT = [
  '- api_endpoint: ONLY a function that directly services an inbound HTTP/RPC request — ' +
    'a framework route handler, a controller action, or a request/response handler. ' +
    'It MUST have structural evidence of this: a route decorator, a (req, res) signature, ' +
    'or a known handler type. Do NOT pick api_endpoint just because a docstring mentions ' +
    '"entry point", "public", "API", or "exported" — a plain getter, query helper, or ' +
    'exported utility is NOT an api_endpoint. When in doubt, prefer business_logic or util.',
  '- business_logic: domain operation, workflow, decision-making, orchestration.',
  '- data_model: type, struct, schema, DTO, persistence record.',
  '- util: pure helper, formatter, parser, generic utility, getter/accessor.',
  '- framework_glue: middleware, adapter, config wiring, lifecycle hook.',
  '- test_helper: fixture, mock builder, assertion helper.',
  '- unknown: cannot determine from the description.',
].join('\n');

interface ClassifierOptions {
  signal?: AbortSignal;
  concurrency?: number;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ClassifierResult {
  candidates: number;
  classified: number;
  cacheHits: number;
  errors: number;
  durationMs: number;
}

interface Candidate {
  nodeId: string;
  name: string;
  kind: string;
  /** Project-relative path. Used by the structural pre-filter to
   *  detect test files via convention (`__tests__/`, `*.test.*`,
   *  `*.spec.*`) before falling through to the LLM. */
  filePath: string;
  signature: string | null;
  /** LLM summary if available; the cascade falls back to docstring otherwise. */
  summary: string | null;
  /** Extractor-derived docstring; populated when the file had JSDoc/docblocks. */
  docstring: string | null;
  /** Whether the symbol is exported — rendered into the LLM evidence block. */
  isExported: number;
}

/** Cascade input: summary if present, else docstring. Trimmed. Empty
 *  strings count as absent. Returns `null` when neither is available
 *  (caller filters those — they shouldn't reach here). */
function descriptionFor(c: Candidate): { text: string; source: 'summary' | 'docstring' } | null {
  if (c.summary && c.summary.trim().length > 0) return { text: c.summary.trim(), source: 'summary' };
  if (c.docstring && c.docstring.trim().length > 0) return { text: c.docstring.trim(), source: 'docstring' };
  return null;
}

/**
 * Tag stamped on `nodes.role_model` for rows classified by the
 * structural pre-filter. Distinct from any chat / local NLI model
 * label so the staleness check in `getClassifiableNodes` can exclude
 * structural rows from re-classification when the backend changes.
 *
 * Bump the version suffix when rules in `classifyByStructure` evolve
 * — that invalidates the cached structural labels via the existing
 * `role_model != ?` mechanism (or a wildcard exclusion in the query;
 * see queries-roles.ts).
 */
export const STRUCTURAL_ROLE_MODEL = 'structural:v2';

// Path patterns: ONLY conventions that exist for the sole purpose of
// holding tests/mocks. `__tests__/` and `__mocks__/` are Jest-style
// conventions; bare `test/` / `spec/` are NOT included because real
// repos use them for non-test code (OpenAPI specs, language-spec
// implementations, etc.).
const TEST_PATH_RE = /(?:^|\/)(?:__tests__|__mocks__)\//;
// Filename test conventions across the languages cartograph supports.
// Cartograph indexes 28+ languages (TS, JS, Svelte, Python, Go, Rust,
// Java, C, C++, C#, PHP, Ruby, Swift, Kotlin, Dart, Pascal, R, Bash,
// Zsh, GraphQL, HCL, SQL, Liquid, ReScript, Scala, Lua, ...). Each
// language community has its own test-file convention; the unified
// regex below covers the dominant ones. Filename-based is the
// portable signal — directory names like `tests/`, `spec/`,
// `src/test/` collide with non-test usage (OpenAPI specs, language-
// spec implementations, JUnit-style production utilities) so they
// are deliberately NOT path-based here.
const TEST_FILENAME_PATTERNS: readonly RegExp[] = [
  // dot-suffixed (JS/TS family + Vue/Svelte/CoffeeScript)
  /\.(?:test|spec)\.(?:[jt]sx?|svelte|vue|cjs|mjs|coffee)$/,
  // snake_case suffix `_test` (Go, Python, Dart, Bash, Zsh)
  /_test\.(?:py|go|dart|sh|bash|zsh)$/,
  // snake_case prefix `test_` (Python, Bash)
  /(?:^|\/)test_[^/]+\.(?:py|sh|bash)$/,
  // snake_case `_spec` suffix (Ruby, Elixir)
  /_spec\.(?:rb|exs?)$/,
  // PascalCase suffix `Test` / `Tests` / `Spec` / `Specs` / `IT`
  // (Java, Kotlin, Scala, Swift, C#, F#, Pascal, ReScript)
  /(?:Test|Tests|Spec|Specs|IT)\.(?:java|kt|kts|scala|sc|swift|cs|fs|fsx|res|resi|pas|dpr)$/,
];

function isTestFilename(filePath: string): boolean {
  return TEST_FILENAME_PATTERNS.some((pattern) => pattern.test(filePath));
}
// Specific framework-handler type names. The pattern requires word
// boundaries so substring matches inside identifiers don't trigger
// (e.g. `MyRequestHandlerBase` matches via word-suffix; `Handler<`
// alone is intentionally NOT here because it collides with every
// generic *Handler<T> in the wild).
const HANDLER_TYPE_RE = /\b(?:APIGatewayProxyHandler|RequestHandler|RouteHandler|HttpHandler)\b/;
// `(req: Request, res: Response)` style signature — requires BOTH
// names together to dodge bare `processRequest(req, ...)` IPC
// handlers. The `req` and `res` (or full `request` / `response`) must
// appear as parameters in that order.
const REQ_RES_PAIR_RE = /\(\s*(?:req(?:uest)?)[^,)]*,\s*(?:res(?:ponse)?)/i;
// Go framework handler shapes — all carry a framework-typed first
// parameter that exists for exactly one purpose, so substring matches
// on application identifiers can't trip these. Covers:
//   - Gin:      (c *gin.Context)
//   - Echo:     (c echo.Context) error
//   - Fiber:    (c *fiber.Ctx) error
//   - net/http: (w http.ResponseWriter, r *http.Request)
//   - cobra:    (cmd *cobra.Command, args []string) — CLI command;
//     treated as api_endpoint (user-facing service boundary). The
//     dedicated cobra route extractor handles command literals via
//     `kind: 'route'`; this signature regex catches handlers that the
//     extractor missed (dynamically-built Commands, methods with the
//     handler signature wired in elsewhere, etc.).
const GO_HANDLER_SIGNATURE_PATTERNS: readonly RegExp[] = [
  /\(\s*\w+\s+\*?gin\.Context\s*\)/,
  /\(\s*\w+\s+echo\.Context\s*\)/,
  /\(\s*\w+\s+\*?fiber\.Ctx\s*\)/,
  /\(\s*\w+\s+http\.ResponseWriter\s*,\s*\w+\s+\*http\.Request\s*\)/,
  /\(\s*\w+\s+\*cobra\.Command\s*,\s*\w+\s+\[\]string\s*\)/,
];

function hasGoHandlerSignature(signature: string): boolean {
  return GO_HANDLER_SIGNATURE_PATTERNS.some((pattern) => pattern.test(signature));
}
/** Parameter decorators (NestJS `@Body`/`@Param`/`@Query`, Spring
 *  `@RequestParam`/`@PathVariable`, FastAPI `Depends`) carried in a
 *  symbol's `signature` — they imply the function is a request handler
 *  (api_endpoint) even when the route extractor missed it. Anchored on
 *  framework-specific identifiers, so it does not catch `@internal`
 *  JSDoc tags. Consumed here by {@link sanitizeApiEndpointRole} and by
 *  the `signature-api-decorator` rule in `role-labeler.ts`. */
export const API_PARAM_DECORATOR_RE =
  /@(?:Body|Param|Query|Headers|Req|Res|Request|Response|Session|Cookies|UploadedFile|RequestParam|PathVariable|RequestBody|ResponseBody|ModelAttribute)\b/;

/**
 * Structural pre-filter — return a high-precision role label when the
 * candidate's structural signals are unambiguous. Returns null when
 * the candidate doesn't match any rule, in which case the caller
 * falls through to the NLI classifier.
 *
 * Rules MUST stay portable across arbitrary indexed repos. Cartograph
 * runs on any codebase the operator points it at, so this pre-filter
 * cannot assume project-specific conventions. Rules added below are
 * either:
 *   - extractor-deterministic (a `kind === 'route'` is whatever the
 *     framework-route extractor emits, by definition an HTTP route)
 *   - filename-extension-based (`*.test.ts` is the universal test-
 *     file convention; bare `test/` / `spec/` directory components
 *     are NOT — those collide with OpenAPI spec dirs, language-spec
 *     implementations, etc.)
 *   - very specific framework type names that exist for one purpose
 *     (`APIGatewayProxyHandler` is unambiguously AWS Lambda HTTP)
 *
 * Rules deliberately NOT included (after a code review showed false
 * positives across plausible repo layouts):
 *   - bare `(req, res)` / `(request)` signature match — false-positives
 *     on internal IPC / queue handlers (`processRequest(req, ...)`)
 *   - `Handler<...>` generic — matches every Angular `ErrorHandler<T>`,
 *     RxJS `OperatorHandler<T>`, DOM `EventHandler<E>`, etc.
 *   - name-pattern `^(?:mock|stub|setup|...)` — false-positives on
 *     production names like `iterator`, `items`, `setupPaymentGateway`
 *
 * NLI handles the residue: business_logic vs util vs framework_glue
 * (and any structurally-ambiguous test_helper / api_endpoint). The
 * NLI head's natural-language priors actually carry signal on those.
 *
 * Returns null on no match. The caller should treat null as "fall
 * through to NLI", not "no role" — the candidate may still be
 * classifiable by NLI.
 */
/** Project-style business_logic name prefixes — mirrors the rule added
 *  to `labelSymbol` in role-labeler.ts (training-time cascade) so the
 *  on-demand `classifyByStructure` path agrees. Camel-case prefix
 *  anchor: `eoFoo` matches, `videoEncoder` doesn't. v2 bump of
 *  STRUCTURAL_ROLE_MODEL refreshes cached `unknown` rows that predate
 *  this rule. */
const BUSINESS_NAME_PREFIX_RE = /^(?:apply|heal|migrate|restore|cgRun|eo|run)[A-Z]/;

export function classifyByStructure(c: {
  kind: string;
  name?: string;
  filePath: string;
  signature: string | null;
}): RoleLabel | null {
  // Test files are test_helpers regardless of internal shape.
  if (TEST_PATH_RE.test(c.filePath) || isTestFilename(c.filePath)) {
    return 'test_helper';
  }
  // Type-only declarations are data models. Extractor-deterministic
  // for `kind` — no NLI needed.
  if (c.kind === 'interface' || c.kind === 'type_alias' || c.kind === 'enum') {
    return 'data_model';
  }
  // Database/schema tables (HCL `table`, SQL CREATE TABLE) are
  // unambiguously data models.
  if (c.kind === 'table') {
    return 'data_model';
  }
  // The route extractor (Express / NestJS / Laravel / etc.) emits
  // `kind === 'route'` only when it has matched a framework route
  // pattern — high precision by construction.
  if (c.kind === 'route') {
    return 'api_endpoint';
  }
  // Express / Lambda / Go-framework handler signatures, conservatively matched.
  const sig = c.signature ?? '';
  if (HANDLER_TYPE_RE.test(sig) || REQ_RES_PAIR_RE.test(sig) || hasGoHandlerSignature(sig)) {
    return 'api_endpoint';
  }
  // Project-style verb-prefix functions / methods that cartograph uses
  // for self-heal, migration runners, and orchestrator-internal flows.
  // Conservative — only fires when the kind is function/method AND the
  // name starts with one of the registered prefixes.
  if ((c.kind === 'function' || c.kind === 'method') && c.name && BUSINESS_NAME_PREFIX_RE.test(c.name)) {
    return 'business_logic';
  }
  return null;
}

/**
 * True when a symbol carries a STRUCTURAL signal that it handles an
 * inbound HTTP request or CLI command — the only sound basis for the
 * `api_endpoint` role. Five signals, the same ones `classifyByStructure`
 * and the `role-labeler.ts` rules treat as api_endpoint evidence: the
 * route extractor tagged it `kind = 'route'`; the signature names a
 * known handler type (`RequestHandler`, …); the signature is an Express
 * `(req, res)` pair; the signature carries a Go framework handler shape
 * (Gin / Echo / Fiber / net/http / cobra); or it carries a framework
 * API parameter decorator (`@Body`, `@RequestParam`, …).
 */
function hasApiEndpointEvidence(input: { kind: string; signature?: string | null }): boolean {
  if (input.kind === 'route') return true;
  const sig = input.signature ?? '';
  return (
    HANDLER_TYPE_RE.test(sig) ||
    REQ_RES_PAIR_RE.test(sig) ||
    hasGoHandlerSignature(sig) ||
    API_PARAM_DECORATOR_RE.test(sig)
  );
}

/**
 * Guard an `api_endpoint` label against unsupported assignment.
 *
 * `api_endpoint` is a STRUCTURAL claim (the symbol services an HTTP
 * request). `classifyByStructure` and the `role-labeler.ts` rules only
 * ever assign it on a structural signal — but the LLM chat classifier
 * can emit it from docstring prose alone: a 3B model reads a doc like
 * "public entry point used by the registry" and outputs `api_endpoint`.
 * When the proposed role is `api_endpoint` but {@link hasApiEndpointEvidence}
 * is false, fold it to `business_logic` — a non-route function a
 * classifier mistook for a handler is, by elimination, domain logic.
 * Every other role, and a structurally-backed `api_endpoint`, passes
 * through unchanged.
 *
 * Apply at the chat-classifier role-write site; structural writes are
 * evidence-backed by construction.
 */
export function sanitizeApiEndpointRole(role: string, input: { kind: string; signature?: string | null }): string {
  if (role !== 'api_endpoint') return role;
  return hasApiEndpointEvidence(input) ? role : 'business_logic';
}

/** Graph-derived structural evidence for one classify candidate,
 *  rendered into the LLM prompt. Cartograph already holds these facts in
 *  the knowledge graph; surfacing them lets the small classifier model
 *  commit to a role instead of punting to `unknown` on a signal-thin
 *  one-line summary (the eval measured 31-60% `unknown` on class-like
 *  kinds when fed name + signature + summary alone). */
interface ClassifyEvidence {
  /** Incoming `calls`-edge count — high for business_logic / spine code. */
  callerCount: number;
  /** The symbol's file imports a known web / DI framework module. */
  frameworkImport: boolean;
  /** Types this symbol extends / implements — the parent often names the role. */
  supertypes: string[];
  /** Member method / field names of a class-like symbol — a behavioural fingerprint. */
  members: string[];
}

/** Render {@link ClassifyEvidence} as a compact one-line clause for the
 *  prompt. Returns '' when there is nothing worth saying. */
function formatRoleEvidence(c: Candidate, ev: ClassifyEvidence | undefined): string {
  const parts: string[] = [];
  if (c.isExported) parts.push('exported');
  if (ev) {
    if (ev.callerCount > 0) parts.push(`${ev.callerCount} caller${ev.callerCount === 1 ? '' : 's'}`);
    if (ev.frameworkImport) parts.push('file imports a web/DI framework');
    if (ev.supertypes.length > 0) parts.push(`extends/implements ${ev.supertypes.join(', ')}`);
    if (ev.members.length > 0) parts.push(`members: ${ev.members.join(', ')}`);
  }
  return parts.join('; ');
}

function buildBatchPrompt(batch: Candidate[], evidenceByNodeId: Map<string, ClassifyEvidence>): string {
  const items = batch.map((c, i) => {
    const sig = c.signature ? ` sig=${c.signature}` : '';
    const desc = descriptionFor(c);
    const descPart = desc ? ` — ${desc.text}` : '';
    const evidence = formatRoleEvidence(c, evidenceByNodeId.get(c.nodeId));
    const evPart = evidence ? ` [${evidence}]` : '';
    return `${i}. ${c.name} (${c.kind})${sig}${descPart}${evPart}`;
  });
  return [
    'Classify the following code symbols. For EACH symbol pick EXACTLY ONE role from:',
    '',
    ROLE_LIST_TEXT,
    '',
    'Symbols (zero-indexed):',
    ...items,
    '',
    'Reply with a JSON object whose "results" array has one entry per',
    'symbol, IN THE SAME ORDER:',
    '{"results":[{"i":0,"role":"<role>"},{"i":1,"role":"<role>"},...]}',
    '',
    'No prose, no markdown fences. Just the JSON object.',
  ].join('\n');
}

/**
 * Parse a batched classify reply into a position→role map.
 *
 * The reply is expected to be the JSON document
 * `{"results":[{"i":0,"role":"…"},…]}` — guaranteed on the
 * grammar-constrained backends (openai-compat / anthropic-api) by
 * {@link BATCH_ROLE_SCHEMA}, best-effort on claude-bridge. This is a
 * thin guard, not a recovery parser: a malformed reply (only the
 * soft-constrained claude-bridge path can produce one) simply yields
 * fewer entries, and the caller defaults the missing positions to
 * `unknown` — no prose-scanning, no per-item LLM retry. Entries with
 * an out-of-range `i` or a non-label `role` are dropped.
 *
 * Exported for direct testing.
 */
/**
 * Zod v4 schema for ONE classify result entry. Applied per-entry in
 * {@link parseBatchRoles}: a row with an unparseable `i` (`z.coerce` +
 * `.int()`) or a non-label `role` fails `safeParse` and is dropped,
 * while valid siblings survive — the caller defaults any missing
 * position to `unknown`. `z.enum(ROLE_LABELS)` is now the canonical
 * role-set membership check (it replaced the standalone `ROLE_SET`).
 */
const RoleEntrySchema = z.object({
  i: z.coerce.number().int(),
  role: z.enum(ROLE_LABELS),
});

export function parseBatchRoles(text: string, expectedSize: number): Map<number, RoleLabel> {
  const out = new Map<number, RoleLabel>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const results =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (!results) return out;
  for (const entry of results) {
    const row = RoleEntrySchema.safeParse(entry);
    if (!row.success) continue;
    const { i: idx, role } = row.data;
    if (idx < 0 || idx >= expectedSize) continue;
    out.set(idx, role);
  }
  return out;
}

/**
 * Run the classifier over every symbol with a non-empty description
 * (summary if present, else docstring) that doesn't yet have a role
 * from the active model. Idempotent.
 */
interface ClassifyAllRolesArgs {
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  options?: ClassifierOptions;
}

export async function classifyAllRoles(args: ClassifyAllRolesArgs): Promise<ClassifierResult> {
  return new RoleClassifierRun(args).run();
}

/**
 * Per-call state for {@link classifyAllRoles}. Workers share a
 * cursor (`nextStart`) and the running counters (`classified`,
 * `errors`, `done`) via instance fields so each worker iteration is
 * a small method instead of a 60-LOC closure with eight captures.
 *
 * Single-shot — `run()` is intended to be called once on a fresh
 * instance.
 */
interface ClassifierCounters {
  done: number;
  classified: number;
  errors: number;
  nextStart: number;
}

class RoleClassifierRun {
  private readonly t0 = Date.now();
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly candidates: Candidate[];
  /** Bundles the 8 collaborator + state fields the per-batch helpers
   *  consume (queries / client / modelLabel / local* / options / total
   *  / counters). Stored as a single readonly object so this class
   *  stays under the god_class member-count threshold while preserving
   *  the original per-field semantics — the helpers still see each
   *  field via `ctx.<field>`. */
  private readonly ctx: ClassifierRunCtx;

  constructor(args: ClassifyAllRolesArgs) {
    const options: ClassifierOptions = args.options ?? {};
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.candidates = getClassifiableNodes(args.queries, args.modelLabel);
    // Pre-compute the per-node caller-count map, per-file framework-
    // import set, and structural neighbourhood ONCE per pass — the
    // classifier's LLM prompt renders a graph-derived evidence block
    // from them. Each is one cheap aggregate over `edges`.
    const callerCountByNodeId = getCallerCountMap(args.queries);
    const frameworkImportFiles = getFrameworkImportFiles(args.queries);
    const neighborhood = getSymbolNeighborhood(args.queries);
    const evidenceByNodeId = new Map<string, ClassifyEvidence>();
    for (const c of this.candidates) {
      const nb = neighborhood.get(c.nodeId);
      evidenceByNodeId.set(c.nodeId, {
        callerCount: callerCountByNodeId.get(c.nodeId) ?? 0,
        frameworkImport: frameworkImportFiles.has(c.filePath),
        supertypes: nb?.supertypes ?? [],
        members: nb?.members ?? [],
      });
    }
    this.ctx = {
      queries: args.queries,
      client: args.client,
      modelLabel: args.modelLabel,
      evidenceByNodeId,
      options,
      total: this.candidates.length,
      counters: { done: 0, classified: 0, errors: 0, nextStart: 0 },
    };
  }

  async run(): Promise<ClassifierResult> {
    await Promise.all(Array.from({ length: this.concurrency }, () => this.worker()));
    return {
      candidates: this.ctx.total,
      classified: this.ctx.counters.classified,
      cacheHits: 0,
      errors: this.ctx.counters.errors,
      durationMs: Date.now() - this.t0,
    };
  }

  private async worker(): Promise<void> {
    const { ctx } = this;
    while (ctx.counters.nextStart < this.candidates.length) {
      if (ctx.options.signal?.aborted) return;
      const start = ctx.counters.nextStart;
      ctx.counters.nextStart += this.batchSize;
      const batch = this.candidates.slice(start, start + this.batchSize);

      // Structural pre-filter is essentially free and high-precision;
      // run it first to drain trivially-typed rows out of the batch.
      // Whatever it can't decide goes to the LLM classifier.
      const residue = applyStructuralPreFilter(ctx, batch);
      if (residue.length === 0) continue;

      await classifierClassifyBatch(ctx, residue, start);
      if (ctx.options.signal?.aborted) return;
    }
  }
}

interface ClassifierRunCtx {
  queries: QueryBuilder;
  client: LlmClient;
  modelLabel: string;
  /** Per-candidate graph-derived evidence rendered into the LLM
   *  classify prompt. Keyed by node id — built once in the
   *  constructor from the caller-count / framework-import / symbol-
   *  neighbourhood aggregates. */
  evidenceByNodeId: Map<string, ClassifyEvidence>;
  options: ClassifierOptions;
  total: number;
  counters: ClassifierCounters;
}

/** Structural pre-filter. Applies high-precision rules (kind,
 *  test-file path, framework-handler signature) and writes matched
 *  candidates to the DB. Returns the unmatched candidates. */
function applyStructuralPreFilter(ctx: ClassifierRunCtx, batch: Candidate[]): Candidate[] {
  // Structural rows are stamped with STRUCTURAL_ROLE_MODEL so the
  // staleness check in getClassifiableNodes excludes them when the
  // backend changes — high-precision structural labels survive
  // backend swaps. Bump STRUCTURAL_ROLE_MODEL when rules evolve.
  const residue: Candidate[] = [];
  for (const c of batch) {
    const heuristic = classifyByStructure(c);
    if (heuristic) {
      upsertSymbolRole(ctx.queries, c.nodeId, { role: heuristic, roleModel: STRUCTURAL_ROLE_MODEL });
      ctx.counters.classified++;
      ctx.counters.done++;
      ctx.options.onProgress?.(ctx.counters.done, ctx.total);
    } else {
      residue.push(c);
    }
  }
  return residue;
}

/**
 * Classify one whole batch in a single grammar-constrained LLM call.
 *
 * {@link BATCH_ROLE_SCHEMA} is passed as `responseSchema`, so on the
 * hard-constrained backends (openai-compat / anthropic-api) every reply is a
 * valid set of role labels by construction — no per-item retry, no
 * prose-scanning. A symbol the model omits, or one the (soft)
 * claude-bridge path mangles, defaults to `unknown` (re-classifiable
 * on a later pass). A context-window failure splits the batch and
 * retries; other chat-level failures mark the whole batch as errored.
 * Every batch member gets a counter update either way.
 */
async function classifierClassifyBatch(ctx: ClassifierRunCtx, batch: Candidate[], start: number): Promise<void> {
  const batchMaxTokens = Math.max(MIN_BATCH_MAX_TOKENS, batch.length * TOKENS_PER_BATCH_ENTRY);
  let result: Awaited<ReturnType<typeof ctx.client.chat>> | undefined;
  try {
    result = await withTransientLlmRetry(
      () =>
        ctx.client.chat(
          [{ role: 'user', content: buildBatchPrompt(batch, ctx.evidenceByNodeId) }],
          compact({
            temperature: 0,
            maxTokens: batchMaxTokens,
            responseSchema: BATCH_ROLE_SCHEMA,
            signal: ctx.options.signal,
          }),
        ),
      { onRetry: (retryErr) => logDebug('Classifier: retrying transient endpoint error', { error: retryErr.message }) },
    );
  } catch (err) {
    if (ctx.options.signal?.aborted) return;
    if (isContextWindowError(err)) {
      await classifierRetryOversizedBatch(ctx, batch, start, err);
      return;
    }
    ctx.counters.errors += batch.length;
    ctx.counters.done += batch.length;
    ctx.options.onProgress?.(ctx.counters.done, ctx.total);
    if (err instanceof LlmEndpointError) {
      logDebug('Classifier: batch endpoint error', { error: err.message });
    } else {
      logWarn('Classifier: batch unexpected error', { error: String(err) });
    }
    return;
  }
  if (ctx.options.signal?.aborted) return;

  const roleByIndex = parseBatchRoles(result.text, batch.length);
  if (roleByIndex.size === 0) {
    logDebug('Classifier: batch reply produced no parseable roles — defaulting to unknown', {
      batchStart: start,
      batchSize: batch.length,
      sample: result.text.slice(0, BATCH_PARSE_FAILURE_LOG_CHARS),
    });
  }

  for (let i = 0; i < batch.length; i++) {
    const c = batch[i]!;
    const label = sanitizeApiEndpointRole(roleByIndex.get(i) ?? 'unknown', c);
    upsertSymbolRole(ctx.queries, c.nodeId, { role: label, roleModel: ctx.modelLabel });
    ctx.counters.classified++;
    ctx.counters.done++;
    ctx.options.onProgress?.(ctx.counters.done, ctx.total);
  }
}

async function classifierRetryOversizedBatch(
  ctx: ClassifierRunCtx,
  batch: Candidate[],
  start: number,
  err: unknown,
): Promise<void> {
  if (batch.length <= 1) {
    const c = batch[0];
    if (!c) return;
    logWarn('Classifier: single candidate exceeded chat context — assigning unknown role', {
      nodeId: c.nodeId,
      name: c.name,
      error: err instanceof Error ? err.message : String(err),
    });
    upsertSymbolRole(ctx.queries, c.nodeId, { role: 'unknown', roleModel: ctx.modelLabel });
    ctx.counters.classified++;
    ctx.counters.done++;
    ctx.options.onProgress?.(ctx.counters.done, ctx.total);
    return;
  }

  const mid = Math.ceil(batch.length / 2);
  logDebug('Classifier: splitting oversized batch', {
    batchStart: start,
    batchSize: batch.length,
    left: mid,
    right: batch.length - mid,
    error: err instanceof Error ? err.message : String(err),
  });
  await classifierClassifyBatch(ctx, batch.slice(0, mid), start);
  if (ctx.options.signal?.aborted) return;
  await classifierClassifyBatch(ctx, batch.slice(mid), start + mid);
}
