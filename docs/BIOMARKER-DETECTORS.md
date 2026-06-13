# Biomarker detector reference

Per-detector thresholds + semantics for all 33 cartograph biomarker
detectors. Split out from the agent-facing project guide (`AGENTS.md`)
to keep it tight. Definitions live in `src/biomarkers/engine.ts`; this
file is the human-readable index.

A finding fires at metric **≥** the value below; clear by landing
strictly below.

**Scan scope — read this first:** per-symbol metric detectors run
ONLY on `function` and `method` nodes (`ANALYSABLE_KINDS` in
`src/biomarkers/per-file-shared.ts`). Constants are exempt from every
per-symbol metric scan — only `stale_doc` (doc-vs-value numbers) and
the file-level `secrets_handling` pass look at them. The practical
consequence for `magic_number` in data-authoring code: hoisting
authored numbers into typed `as const` records is the sanctioned fix,
not a loophole — a table of constants is exactly where such numbers
belong.

## Per-symbol structural / complexity (always on)

- `long_parameter_list` — info ≥ 4 params, warning ≥ 5, error ≥ 7.
- `complex_method` (cyclomatic) — warning ≥ 15, error ≥ 25.
- `large_method` (LOC) — warning ≥ 100, error ≥ 200.
- `complex_conditional` (operands) — warning ≥ 6, error ≥ 8.
- `nested_complexity` (depth) — warning ≥ 5, error ≥ 7.

## Cross-file structural (full-pass only)

- `god_class` (member count) — info ≥ 15, warning ≥ 40, error ≥ 60.
  Only fires on a class-like node that ALSO has ≥1 method/function
  child. Method-less data/schema structs (Zod `z.object(...)`, data
  records) are NOT god classes — `findGodClasses` in
  `src/db/queries-biomarkers-graph.ts` excludes them.
- `unused_export` — exported symbols with no incoming graph edge from
  outside their own file. Fix: drop the `export` keyword if used only
  in own file; delete per YAGNI if used nowhere.
- `feature_envy` — methods reading many fields off ANOTHER class while
  barely touching their own data (ATFD / LAA / FDP per Lanza &
  Marinescu's textbook). Fires when ATFD > 5 AND FDP ≤ 2 AND LAA < 1/3.
- `illegal_import` — user-defined architectural layering violations
  (opt-in via `CartographConfig.layers`).
- `low_coverage` — under-covered symbols in the upper tail of the
  codebase's centrality distribution (a RELATIVE percentile floor — top
  decile warn / top ~2% error — so it fires consistently across repo
  sizes, where a fixed absolute floor sat above the whole under-covered
  population on larger graphs). Covers `function`, `method`, AND
  `component` kinds, matching `coverage --mode ranked`. Reads the most
  recently ingested lcov source; silent until coverage is loaded.
  Coverage-dependent, so it is excluded from the structural biomarker
  floor gate (see `ARCHITECTURE.md`); findings still surface in
  `cartograph_biomarkers` / `digest` / `review`. To clear: regenerate
  with `bun test --coverage`, re-ingest via `cartograph coverage --mode
  refresh`, then full reindex.
- `duplicate_code` — exact (Type-1) / near (Type-2) / partial (Type-3)
  / semantic (Type-4) clones. See `src/biomarkers/duplicate-code.ts` for
  the per-tier bucketing logic.

## Anti-pattern tier (B17/B19/B20/B21 — added 2026-05-23)

Each is a textual-regex scan over `bodyNode.text` (one WASM round-trip
per symbol, amortised across all four) gated on per-language allowlist.

- `accidental_quadratic` (Schlemiel count, B17) — warning ≥ 1,
  error ≥ 5. Per-file; JS/TS-family gated. Catches `for (i;
  i<X.namedChildCount; i++) X.namedChild(i)` shape — `namedChild(i)`
  is O(i) so the loop is O(n²). Extend the
  `ACCIDENTAL_QUADRATIC_PATTERNS` allowlist in `engine.ts` when a
  new known-O(n) accessor surfaces.
- `empty_catch` (count, B19) — warning ≥ 1, error ≥ 3. All languages
  (catch syntax is identical across JS/TS/Java/C#/etc.). Skipped when
  the catch body has any non-whitespace content (a comment counts as
  documented intentional suppression).
- `sync_io_in_async` (count, B20) — warning ≥ 1, error ≥ 3. Per-file;
  JS/TS-family gated. Detects `fs.readFileSync` / `execSync` / etc.
  inside an `async function` body via the `SYNC_IO_CALLS` allowlist.
- `forof_await` (count, B21) — info ≥ 1, warning ≥ 2, error ≥ 5.
  Softer thresholds — sometimes sequential is intentional for
  back-pressure / ordering. Per-file; JS/TS-family gated. Skips
  `for await (...)` (intentional async iteration).

Adding a new anti-pattern detector is a one-file pattern: add to
`BIOMARKER_NAMES`, add a counter to `SymbolMetrics`, wire into
`computeMetrics`, register a `SIMPLE_RULES` entry with thresholds,
write a test in `__tests__/anti-pattern-detectors.test.ts`.

## G26 agent-prone tier (added 2026-05-24c/25)

Twelve detectors targeting code patterns AI agents disproportionately
produce. Surface them — alongside the four anti-pattern-tier detectors
above (B17/B19/B20/B21), for 16 agent-prone biomarkers total — via
`cartograph_review({mode: 'agent-audit'})` or `cartograph review agent-audit`.

### Phase 1 (2026-05-24c)

- `ts_any_cast` (count, G26) — info ≥ 2, warning ≥ 3, error ≥ 5.
  TS+TSX only. Counts `as any` + `as unknown as X`. Info kicks in
  at 2 (not 1) — one cast is often legit at an FFI boundary.
  Comment-stripped before counting so JSDoc examples don't false-trip.
- `ts_ignore_suppression` (count, G26) — warning ≥ 1, error ≥ 3.
  TS+TSX only. Matches `// @ts-ignore` / `// @ts-expect-error`.
  Raw-body scan (the patterns LIVE in comments).
- `agent_debug_log` (count, G26) — warning ≥ 1, error ≥ 5. JS/TS-
  family gated. Counts `console.{log,error,warn,info,debug}(` calls
  IN THE STRIPPED BODY; the gate (raw body contains `process.env` /
  `DEBUG` / `VERBOSE` / `TRACE`) skips intentional diagnostic code.
  Routes through stdout/stderr.write (which the detector doesn't
  match) for CLI / profile output.
- `incomplete_marker` (count, G26) — info ≥ 1, warning ≥ 5, error
  ≥ 50. Any-language. Matches TODO / FIXME / XXX / HACK markers +
  `throw new Error('not implemented')` shape + Python
  `NotImplementedError`. Raw-body scan (the patterns LIVE in
  comments / strings).
- `dynamic_eval` (count, G26) — warning = error = 1 (fires error on
  any occurrence). JS/TS-family. Matches `eval(` and `new Function(`.
  Comment-stripped.
- `insecure_hash` (count, G26) — warning ≥ 1, error ≥ 3. JS/TS-
  family. Matches `createHash('md5'|'sha1')` case-insensitive.
  Comment-stripped.
- `random_for_security` (count, G26) — warning = error = 1.
  JS/TS-family. Counts `Math.random()` IN THE STRIPPED BODY when
  the RAW body mentions a security keyword (`token` / `secret` /
  `password` / `nonce` / `salt` / `csrf` / `sessionId` /
  `authToken` / `apiKey` / `privateKey` / `accessKey`).

### Phase 2 (2026-05-25)

- `http_no_timeout` (count, G26-P2) — warning ≥ 1, error ≥ 3.
  JS/TS-family. Counts `fetch(` / `axios.{get,post,…}(` calls in a
  body that doesn't mention `timeout` or `signal` (the
  AbortController + axios deadline keywords).
- `sql_string_concat` (count, G26-P2) — warning ≥ 1, error ≥ 2.
  JS/TS-family. Matches SQL templates with `${…}` interpolation AND
  string-concat SQL (`'SELECT …' +`). Two FP gates: skips when the
  body has BOTH `.prepare(` AND a literal `'?'` (placeholder-count
  idiom); also skips per-template when every `${…}` is a bare
  identifier (`${table}` / `${tableName}`) — the codebase's
  dynamic-DDL + vec0 table-name shape. Real injection (member access
  / function-call interpolation, string concat) still fires. Call
  sites that need to interpolate `obj.prop` should copy to a local
  first: `const tableName = obj.tableName; … ${tableName}`.
- `unsafe_json_parse` (count, G26-P2) — warning ≥ 1, error ≥ 3.
  JS/TS-family. Counts `JSON.parse(` calls in a body with no
  `try`/`catch` block.
- `env_no_validation` (count, G26-P2) — warning ≥ 1, error ≥ 3.
  JS/TS-family. Counts `process.env.NAME` (dot-access) reads in a
  body that doesn't use Zod (no `z.` reference). Bracket-access
  `process.env['NAME']` is the codebase's intentional opt-in
  pattern and is exempted.
- `empty_function_body` (count, G26-P2) — info ≥ 1, warning/error
  effectively disabled. All languages. Matches `{}` / `{ return; }`
  / `{ return null|undefined; }`. Skipped when the body has a
  non-trivial comment (silentLogger-style intentional no-op).

## Other per-symbol detectors

- `magic_number` — literals not in {0, 1, -1, 2}; escalates by COUNT
  per symbol: info ≥ 3, warning ≥ 5, error ≥ 8 (`T_MAGIC`). "Info-tier"
  describes the floor, not the ceiling — fix against the error bar
  when driving a repo to zero.
- `hardcoded_url` — literal HTTP(S) URLs; escalates by count per
  symbol: info ≥ 1, warning ≥ 2, error ≥ 3.
- `recently_grew` — large LOC delta since last snapshot.
- `stale_doc` — fires when a constant's doc cites numbers absent
  from its value. Fix: make the doc accurate; never remove numbers
  as suppression. Conservative by construction: signatures truncated
  at the extraction cap are skipped (a disjoint verdict against
  partial text would be a guess), as are regex-literal initializers
  (pattern digits are not values); unit-suffixed tokens (`0.85in`,
  `1.5x`) and spaced unit words (`5 minutes`, `10 MB`, `~10–20 ms`
  ranges) are measurements, not value claims; hyphen-compound
  references (`audit-4`) are identifiers; `$96K`/`$2.4M` money
  shorthand is expanded before comparison (`$`-prefixed only — bare
  `5M rows` is quantity rationale); and both `5_000` numeric
  separators and `10 000` prose spacing read as the plain number.
- `secrets_handling` — symbols handling secrets/PII per the
  `src/llm/secrets-detector.ts` patterns. Self-exempt allowlist in
  `src/biomarkers/per-file-shared.ts:SECRETS_RULE_SELF_PATHS`
  (rule self-impl files + LLM-setup files that legitimately
  reference env-var names).
- `brain_method` — composite of {complex, large, nested, many-params}.
