/**
 * Biomarker types — keep separate from the engine so a single import
 * doesn't drag the tree-sitter dispatch in for consumers that just
 * want to read findings out of the DB.
 */

/** Names of every biomarker the engine can emit. The DB CHECK
 *  constraint on `severity` is independent — a new biomarker only
 *  needs an entry here. */
export const BIOMARKER_NAMES = [
  'large_method',
  'complex_method',
  'nested_complexity',
  'complex_conditional',
  'brain_method',
  'long_parameter_list',
  'magic_number',
  'hardcoded_url',
  'recently_grew',
  'stale_doc',
  'unused_export',
  'god_class',
  'feature_envy',
  'illegal_import',
  'secrets_handling',
  'low_coverage',
  'duplicate_code',
  // B17 (2026-05-23) — "Schlemiel the Painter" patterns (Spolsky 2001):
  // indexed-loop over an O(n) accessor compounds to O(n²) per parent.
  // Per-file detector — gated to JS/TS where the bug class is bound to
  // web-tree-sitter's `namedChild(i)` shape. See `engine.ts:
  // ACCIDENTAL_QUADRATIC_PATTERNS` for the allowlist + the regex that
  // emits findings.
  'accidental_quadratic',
  // B19 (2026-05-23) — `catch (e) {}` with empty body silently
  // swallows errors. Most common cause of "the system claims success
  // but nothing worked." Skip when the catch body contains a comment
  // (intentional suppression should be documented).
  'empty_catch',
  // B20 (2026-05-23) — `fs.readFileSync` / `execSync` / etc. inside
  // an `async` function blocks the event loop in code that's claiming
  // to be async. Per-file detector, JS/TS-gated.
  'sync_io_in_async',
  // B21 (2026-05-23) — `for (const x of items) { await foo(x) }` runs
  // sequentially when `Promise.all(items.map(foo))` would parallelize.
  // Per-file detector, JS/TS-gated. Softer threshold than B19/B20 —
  // sometimes sequential is intentional for back-pressure / ordering.
  'forof_await',
  // G26 (2026-05-24c) — agent-prone biomarker tier, Phase 1. Seven
  // detectors targeting code patterns that AI agents (per arXiv
  // studies + CodeRabbit / Greptile / SonarQube field data) generate
  // disproportionately when papering over a type error, swallowing a
  // failure, or shipping a half-implemented function. Same SIMPLE_RULES
  // shape as B17-B21 — per-symbol body scan with per-detector regex
  // + language gate.
  /** `as any` / `as unknown as X` casts inside a symbol body. The
   *  canonical "agent ran into a type error and suppressed it"
   *  pattern. TS-only (JS has no cast syntax). Soft at 1, warn 3,
   *  error 5 — one cast is sometimes justified at an FFI boundary;
   *  three or more in one body is almost always type laundering. */
  'ts_any_cast',
  /** ts-ignore / ts-expect-error suppression comments (the
   *  `// @ts-` directive shape) in a symbol body. Same "papered-over
   *  type error" smell as `ts_any_cast` but more explicit — at least
   *  the author marked it. TS-only. Warn at 1, error 3. */
  'ts_ignore_suppression',
  /** `console.log` / `console.error` / `console.warn` / `console.info`
   *  / `console.debug` calls NOT gated behind a `process.env` or
   *  DEBUG/VERBOSE/TRACE-keyword check in the same body. The canonical
   *  "agent left debug prints in production code" pattern. JS/TS-gated.
   *  Warn at 1, error 5. Path-based carve-outs (CLI bin, bench) would
   *  need a higher-layer gate not present in SIMPLE_RULES. */
  'agent_debug_log',
  /** Incomplete-work marker comments + the
   *  `throw new Error('not implemented')` shape inside a symbol body.
   *  The canonical "agent stubbed it and moved on" pattern. All
   *  languages (comment-like markers are universal). Info at 1, warn
   *  at 5. */
  'incomplete_marker',
  /** `eval(...)` or `new Function(...)` calls — dynamic code
   *  generation. Agents reach for this when they can't figure out
   *  how to call a method statically. JS/TS-gated. Any occurrence
   *  is an error (warn=error=1). */
  'dynamic_eval',
  /** `createHash('md5')` / `createHash('sha1')` — broken-for-security
   *  hash functions. Both have known collision attacks; modern code
   *  should use sha256+. Warn at 1, error at 3. */
  'insecure_hash',
  /** `Math.random()` calls inside a body that ALSO mentions a
   *  security-context keyword (token, secret, password, nonce, salt,
   *  csrf, session/auth token, apiKey, privateKey, accessKey).
   *  `Math.random()` is NOT cryptographically secure — agents
   *  routinely reach for it instead of `crypto.randomBytes`. JS/TS-
   *  gated. Any occurrence is an error (warn=error=1) — false-positive
   *  rate is bounded by the keyword gate. */
  'random_for_security',
  // G26 Phase 2 (2026-05-25) — five more agent-prone detectors. Same
  // SIMPLE_RULES shape as Phase 1 (per-symbol body scan, JS/TS-gated
  // unless noted), targeting the next wave of patterns agents
  // disproportionately generate when shipping incomplete or
  // unhardened code.
  /** `fetch(...)` / `axios.{get,post,...}(...)` calls inside a body
   *  that doesn't mention `timeout` or `signal`. Network calls
   *  without a deadline can hang forever — agents routinely forget
   *  AbortController / axios timeout. JS/TS-gated. */
  'http_no_timeout',
  /** SQL statements built via template-literal interpolation
   *  (``\`SELECT * FROM ${table}\``) or string concat (`'SELECT ...' +
   *  variable`). The injection pattern — agents reach for string
   *  templating when they don't know the parameterised-query API.
   *  JS/TS-gated. */
  'sql_string_concat',
  /** `JSON.parse(...)` calls in a body that has no `try`/`catch`
   *  block. Unhandled JSON throws on every malformed input — agents
   *  routinely forget the catch when round-tripping config /
   *  network payloads. JS/TS-gated. */
  'unsafe_json_parse',
  /** `process.env.NAME` (dot-access) reads in a body that doesn't
   *  also use a Zod schema (`z.` reference). The codebase's intentional
   *  env-var pattern is `process.env['NAME']` (bracket-access), so
   *  flagging dot-access narrows to the agent-prone "I grabbed an
   *  env var directly and used it" shape. JS/TS-gated. */
  'env_no_validation',
  /** Function / method bodies that are essentially empty —
   *  `{ }`, `{ return; }`, `{ return undefined; }`. Agents stub a
   *  signature and move on. Skipped on explicit no-op overrides
   *  (the body's only content is a comment — documenting intent).
   *  All languages (the empty-body shape is universal). */
  'empty_function_body',
] as const;

export type BiomarkerName = (typeof BIOMARKER_NAMES)[number];

/**
 * Cross-file biomarker kinds — those computed from global graph
 * state (not from a single file's AST). The single source of truth
 * referenced by:
 *   - replaceFindingsForFile (so per-file replace doesn't wipe them)
 *   - the analyseProject cross-file pass (so we know which kinds to
 *     re-emit on a full pass)
 *   - runCrossFileRule's `kind` parameter (compile-time guard so
 *     forgetting to add a new rule's name here breaks the build
 *     instead of silently corrupting the per-file replace path)
 *
 * Adding a new cross-file rule? Add its name here AND in BIOMARKER_NAMES.
 * The `satisfies` clause below enforces the second half at compile time.
 */
const CROSS_FILE_BIOMARKER_NAMES = [
  'unused_export',
  'god_class',
  'feature_envy',
  'illegal_import',
  'low_coverage',
  'duplicate_code',
] as const satisfies readonly BiomarkerName[];

export type CrossFileBiomarkerName = (typeof CROSS_FILE_BIOMARKER_NAMES)[number];

export const CROSS_FILE_BIOMARKERS: ReadonlySet<BiomarkerName> = new Set(CROSS_FILE_BIOMARKER_NAMES);

export type Severity = 'info' | 'warning' | 'error';

/**
 * Severities ordered most-severe-first — the single source of truth
 * for severity ordering. Iterate this for display (highest first);
 * use {@link compareSeverity} for ranking comparisons. Don't
 * re-express `error > warning > info` ad hoc.
 */
export const SEVERITY_DESC = ['error', 'warning', 'info'] as const satisfies readonly Severity[];

/** Rank map derived from {@link SEVERITY_DESC} — higher = more severe. */
const SEVERITY_RANK: Record<Severity, number> = Object.fromEntries(
  SEVERITY_DESC.map((s, i) => [s, SEVERITY_DESC.length - 1 - i]),
) as Record<Severity, number>;

/** Comparator: > 0 when `a` is more severe than `b`, < 0 when less,
 *  0 when equal. Sorts ascending (info first); negate for descending. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export interface Finding {
  /** Node id from the `nodes` table the finding attaches to. */
  nodeId: string;
  biomarker: BiomarkerName;
  severity: Severity;
  /** Numeric metric the finding was raised on (LoC, max nesting,
   *  cyclomatic count, …). Lets agents reason about *how* bad. */
  metric: number;
  /** Free-form JSON-serialisable extra context. */
  detail?: unknown;
}
