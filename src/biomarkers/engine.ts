/**
 * Biomarker analysis engine.
 *
 * Walks the tree-sitter AST of a single function/method and computes:
 *   - line count (LoC) — for Large Method
 *   - cyclomatic complexity — count of branching nodes + 1
 *   - maximum nesting depth — for Nested Complexity
 *   - per-conditional operand count — for Complex Conditional
 *
 * The biomarker definitions in `./biomarkers/<name>.ts` consume these
 * metrics and decide whether to emit a Finding.
 */

import type { Node as TsNode, Tree } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars.js';
import type { Language } from '../types.js';
import { getLangMap, type LangMap } from './lang-map.js';
import type { Finding, Severity } from './types.js';
import { detectSecretsHandling } from '../llm/secrets-detector.js';
import { stripJsComments } from '../resolution/import-resolver.js';
import { escapeRegExp } from '../utils.js';
import { parseStrictDecimalNumber } from '../strict-numeric.js';

interface SymbolMetrics {
  /** LoC = endLine - startLine + 1 (the symbol's source span). */
  loc: number;
  /** Cyclomatic complexity: 1 + number of branching nodes inside the
   *  symbol's body. */
  cyclomatic: number;
  /** Deepest nesting count seen below the symbol's outer block. */
  maxNesting: number;
  /** Operand count of the most-complex conditional inside the symbol
   *  body. 0 if the symbol contains no conditional. */
  maxConditionalOperands: number;
  /** Number of formal parameters declared on the symbol's signature.
   *  Counted from the AST during {@link computeMetrics}. */
  paramCount: number;
  /** Count of numeric literals inside the body that are NOT part of
   *  a small allow-list (0, 1, -1, 2). Used by the magic_number rule. */
  magicNumberCount: number;
  /** Count of URL-like string literals inside the body — `http://…`,
   *  `https://…`, `ws://…`, `wss://…`. Used by the hardcoded_url rule. */
  hardcodedUrlCount: number;
  /** Count of "Schlemiel the Painter" loops in the body — indexed
   *  for-loops over an O(n) accessor that compound to O(n²) per parent.
   *  Detector textually scans for known-bad shape pairs from
   *  {@link ACCIDENTAL_QUADRATIC_PATTERNS}. Drives the
   *  `accidental_quadratic` biomarker. JS/TS-gated (the known bug class
   *  is bound to web-tree-sitter's `namedChild(i)` shape). */
  accidentalQuadraticCount: number;
  /** Count of `catch (e) {}` (or `catch {}`) with an EMPTY body in
   *  the symbol's source. Empty catches silently swallow errors —
   *  the most common cause of "the system claims success but nothing
   *  worked." Skipped when the catch body has any non-whitespace
   *  content (a comment counts as documented suppression). Drives
   *  the `empty_catch` biomarker. */
  emptyCatchCount: number;
  /** Count of sync I/O calls (`fs.readFileSync` / `execSync` / etc.)
   *  inside an `async` function body. Blocks the event loop in code
   *  that's claiming to be async. Detector heuristic: regex for the
   *  sync calls; gated to bodies whose first non-whitespace tokens
   *  include `async`. Drives the `sync_io_in_async` biomarker.
   *  JS/TS-gated. */
  syncIoInAsyncCount: number;
  /** Count of `for (... of ...) { await ... }` loops — sequential
   *  await when `Promise.all(items.map(foo))` would parallelize.
   *  False-positive guards: skipped on `for await (...)` (intentional
   *  async iteration). Drives the `forof_await` biomarker. JS/TS-gated. */
  forofAwaitCount: number;
  /** G26 (2026-05-24c) — count of `as any` / `as unknown as X` casts.
   *  TS-only. Drives the `ts_any_cast` biomarker. */
  tsAnyCastCount: number;
  /** G26 — count of ts-ignore / ts-expect-error directives (literal
   *  `// @ts-` form) in the symbol body. TS-only. Drives the
   *  `ts_ignore_suppression` biomarker. */
  tsIgnoreSuppressionCount: number;
  /** G26 — count of `console.{log,error,warn,info,debug}(` calls NOT
   *  gated behind a `process.env` / DEBUG / VERBOSE / TRACE keyword
   *  in the same body. JS/TS-gated. Drives the `agent_debug_log`
   *  biomarker. */
  agentDebugLogCount: number;
  /** G26 — count of incomplete-work markers and
   *  `throw new Error('not implemented')` shape. All languages.
   *  Drives the `incomplete_marker` biomarker. */
  incompleteMarkerCount: number;
  /** G26 — count of `eval(...)` and `new Function(...)` calls.
   *  JS/TS-gated. Drives the `dynamic_eval` biomarker. */
  dynamicEvalCount: number;
  /** G26 — count of `createHash('md5'|'sha1')` calls — broken-for-
   *  security hashes. Drives the `insecure_hash` biomarker. */
  insecureHashCount: number;
  /** G26 — count of `Math.random()` calls inside a body that mentions
   *  a security-context keyword (token, secret, password, nonce, salt,
   *  csrf, session/auth token, apiKey, privateKey, accessKey).
   *  JS/TS-gated. Drives the `random_for_security` biomarker. */
  randomForSecurityCount: number;
  /** G26 Phase 2 — count of `fetch(` / `axios.X(` calls in a body
   *  that doesn't mention `timeout` or `signal`. Drives the
   *  `http_no_timeout` biomarker. JS/TS-gated. */
  httpNoTimeoutCount: number;
  /** G26 Phase 2 — count of SQL statements built via template-literal
   *  interpolation or string concat. Drives the `sql_string_concat`
   *  biomarker. JS/TS-gated. */
  sqlStringConcatCount: number;
  /** G26 Phase 2 — count of `JSON.parse(...)` calls in a body that
   *  has no `try` / `catch`. Drives the `unsafe_json_parse`
   *  biomarker. JS/TS-gated. */
  unsafeJsonParseCount: number;
  /** G26 Phase 2 — count of `process.env.NAME` (dot-access only)
   *  reads in a body that doesn't also use a Zod schema. Drives the
   *  `env_no_validation` biomarker. JS/TS-gated. */
  envNoValidationCount: number;
  /** G26 Phase 2 — 1 if the body is essentially empty
   *  (`{}` / `{ return; }` / `{ return null|undefined; }`), 0
   *  otherwise. Drives the `empty_function_body` biomarker. All
   *  languages — the empty-body shape is universal. */
  emptyFunctionBodyCount: number;
}

const CYCLOMATIC_BASE = 1;

/** Conservative empty result — used when the language has no LangMap. */
function emptyMetrics(loc: number): SymbolMetrics {
  return {
    loc,
    cyclomatic: CYCLOMATIC_BASE,
    maxNesting: 0,
    maxConditionalOperands: 0,
    paramCount: 0,
    magicNumberCount: 0,
    hardcodedUrlCount: 0,
    accidentalQuadraticCount: 0,
    emptyCatchCount: 0,
    syncIoInAsyncCount: 0,
    forofAwaitCount: 0,
    tsAnyCastCount: 0,
    tsIgnoreSuppressionCount: 0,
    agentDebugLogCount: 0,
    incompleteMarkerCount: 0,
    dynamicEvalCount: 0,
    insecureHashCount: 0,
    randomForSecurityCount: 0,
    httpNoTimeoutCount: 0,
    sqlStringConcatCount: 0,
    unsafeJsonParseCount: 0,
    envNoValidationCount: 0,
    emptyFunctionBodyCount: 0,
  };
}

/**
 * Allowlist of `(countAccessor, itemAccessor)` pairs known to be O(n²)
 * when iterated via `for (let i=0; i<X.countAccessor; i++) X.itemAccessor(i)`.
 * Each pair represents an accessor that walks the underlying collection
 * from the start on every call — making the indexed loop quadratic.
 *
 * B17 (2026-05-23) — seeded with web-tree-sitter's child accessors, the
 * "Schlemiel the Painter" pattern (Spolsky 2001) that B14/B15 measured
 * eating 99% of `visitNode` wall on microsoft/TypeScript. Confirmed by
 * profile: a single `namedChild(i)` call hit 100 ms on a parent with
 * thousands of children, scaling linearly with `i`.
 *
 * Add new pairs here when a future bug-hunt finds another O(i) accessor
 * — the detector regex pulls names from this list, so a one-line entry
 * is the whole extension shape.
 */
export const ACCIDENTAL_QUADRATIC_PATTERNS: ReadonlyArray<{
  countAccessor: string;
  itemAccessor: string;
  /** Short label used in the finding's `detail`. */
  source: string;
}> = [
  { countAccessor: 'namedChildCount', itemAccessor: 'namedChild', source: 'web-tree-sitter' },
  { countAccessor: 'childCount', itemAccessor: 'child', source: 'web-tree-sitter' },
];

/**
 * Build the regex from {@link ACCIDENTAL_QUADRATIC_PATTERNS}. Matches:
 *   `for (let|var|const <idx> = 0; <idx> < <expr>.<count>; <idx>++)`
 * followed within a short window by `<expr>.<item>(<idx>)`. The window
 * (300 chars) is generous enough to span a multi-line loop body header
 * while staying tight enough to avoid matching across unrelated code.
 *
 * Exported so the wording-lint test can walk the same regex the
 * detector emits findings from.
 */
export function buildAccidentalQuadraticRegex(): RegExp {
  const countAlt = ACCIDENTAL_QUADRATIC_PATTERNS.map((p) => p.countAccessor).join('|');
  const itemAlt = ACCIDENTAL_QUADRATIC_PATTERNS.map((p) => p.itemAccessor).join('|');
  return new RegExp(
    String.raw`for\s*\(\s*(?:let|var|const)\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*[\w.\[\]]+\.(?:${countAlt})\s*;\s*\1\s*\+\+\s*\)[^{]*\{[^}]{0,300}\.(?:${itemAlt})\s*\(\s*\1\s*\)`,
    'g',
  );
}

/** Cached compiled regex — built once at module load. */
const ACCIDENTAL_QUADRATIC_RE = buildAccidentalQuadraticRegex();

/** Build a sibling-aware-use regex specific to a captured index name.
 *  Matches `<idx> + N` / `<idx> - N` anywhere — the captured idx must
 *  match exactly (word-boundary) so unrelated math elsewhere in the
 *  body doesn't trip it. Used as a false-positive guard: if any such
 *  pattern appears in the body source after a match, the loop has a
 *  legitimate reason to use its index — skip the finding. */
function buildSiblingIndexUseRegex(idxName: string): RegExp {
  // Escape + identifier-char lookbehind so a `$`-bearing index name
  // (rare but legal) doesn't turn `$` into a regex anchor and silently
  // disable the false-positive guard.
  return new RegExp(String.raw`(?<![\w$])${escapeRegExp(idxName)}\s*[+-]\s*\d+`);
}

/** JS/TS-family languages where the known bug class (web-tree-sitter's
 *  `namedChild(i)` shape) actually manifests. Other languages can match
 *  the regex textually (Java has `getChild(i)` etc.) but the O(n²) cost
 *  depends on the binding, not the syntax — keep the gate tight to
 *  avoid false positives. */
const ACCIDENTAL_QUADRATIC_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/**
 * Count "Schlemiel the Painter" indexed-loop occurrences in the given
 * source slice. Returns 0 when the language isn't in the allowlist OR
 * when a candidate match also contains sibling-index use (skip — the
 * loop has a legitimate reason to index).
 *
 * Source is the bodyNode.text equivalent — caller passes it in so we
 * don't double-cost the WASM string copy. Pure textual; no AST.
 *
 * Exported for unit-testability.
 */
export function countAccidentalQuadratic(bodySource: string, language: Language): number {
  if (!ACCIDENTAL_QUADRATIC_LANGUAGES.has(language)) return 0;
  let count = 0;
  // Reset regex state — the cached `g`-flag instance carries lastIndex
  // across calls.
  ACCIDENTAL_QUADRATIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACCIDENTAL_QUADRATIC_RE.exec(bodySource)) !== null) {
    // Sibling-aware-use guard: if `<idxName> + N` or `<idxName> - N`
    // appears ANYWHERE in the body source, the loop has a legitimate
    // reason to index (next/previous-sibling access). Conservatively
    // over-skip (false negative beats false positive on a perf
    // detector — a missed Schlemiel is recoverable, a noisy detector
    // gets ignored).
    const idxName = m[1];
    if (idxName === undefined) continue;
    const siblingRe = buildSiblingIndexUseRegex(idxName);
    if (siblingRe.test(bodySource)) continue;
    count++;
  }
  return count;
}

// ---- B19: empty_catch -----------------------------------------------
//
// `catch (e) {}` / `catch {}` with empty braces. Permissive whitespace
// match; if there's a comment inside, the body isn't "empty" by our
// definition — the comment documents intentional suppression.
//
// Exported for unit-testability.
export const EMPTY_CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/** Count empty-body `catch` clauses in the symbol body. All-language
 *  applicable (catch syntax is essentially identical across the
 *  JS/TS/Java/C#/Kotlin/Scala/Swift family). For languages without
 *  `catch` (Go, Rust, Python — Python uses `except`) the regex won't
 *  match anything, so the count is naturally 0 without an explicit
 *  language gate. */
export function countEmptyCatch(bodySource: string): number {
  let count = 0;
  EMPTY_CATCH_RE.lastIndex = 0;
  while (EMPTY_CATCH_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- B20: sync_io_in_async ------------------------------------------
//
// Sync I/O calls (`fs.readFileSync`, `execSync`, etc.) inside an
// `async` function body. Blocks the event loop on code that's claiming
// to be async. Detector heuristic: gate on body source containing the
// `async` keyword (best-effort — picks up `async function` and
// `async (...) =>` shapes), then count occurrences of the sync I/O
// call set.

/** Sync I/O call names that should never appear inside an async body. */
export const SYNC_IO_CALLS: ReadonlyArray<string> = [
  'readFileSync',
  'writeFileSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'mkdirSync',
  'rmSync',
  'unlinkSync',
  'execSync',
  'execFileSync',
  'spawnSync',
];

/** Build the call-name regex from {@link SYNC_IO_CALLS}. `\b` word
 *  boundary so `unlinkSync` doesn't match `myUnlinkSync`. */
function buildSyncIoCallsRegex(): RegExp {
  return new RegExp(String.raw`\b(?:${SYNC_IO_CALLS.join('|')})\s*\(`, 'g');
}

const SYNC_IO_CALLS_RE = buildSyncIoCallsRegex();

/** Heuristic: body's signature line contains `async`. Matches both
 *  `async function f(...)` and `async (...) =>` arrow shapes. */
const ASYNC_SIGNATURE_RE = /\basync\b/;

/** JS/TS-family gate (same as accidental_quadratic). */
const SYNC_IO_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/** Count sync I/O calls inside an async body. Returns 0 when the
 *  body isn't async OR the language isn't in the gate. */
export function countSyncIoInAsync(bodySource: string, language: Language): number {
  if (!SYNC_IO_LANGUAGES.has(language)) return 0;
  if (!ASYNC_SIGNATURE_RE.test(bodySource)) return 0;
  let count = 0;
  SYNC_IO_CALLS_RE.lastIndex = 0;
  while (SYNC_IO_CALLS_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- B21: forof_await -----------------------------------------------
//
// `for (const x of items) { await foo(x) }` — sequential await when
// `Promise.all(items.map(foo))` would parallelize. False-positive
// guard: `for await (...)` is intentional async iteration; the
// regex's leading `\bfor\s*\(` (not `for\s+await`) excludes it.

/** Matches `for (... of ...) { ... await ... }` where the body
 *  contains an await. Permissive — the body window of 400 chars
 *  spans most realistic loop bodies. */
export const FOROF_AWAIT_RE = /\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+[^)]+\)\s*\{[^}]{0,400}\bawait\b/g;

/** JS/TS-family gate. */
const FOROF_AWAIT_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/** Count sequential-await for-of loops in the body. */
export function countForofAwait(bodySource: string, language: Language): number {
  if (!FOROF_AWAIT_LANGUAGES.has(language)) return 0;
  let count = 0;
  FOROF_AWAIT_RE.lastIndex = 0;
  while (FOROF_AWAIT_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26: ts_any_cast ----------------------------------------------
//
// `as any` / `as unknown as X` casts. TS-only (JS has no cast
// syntax). The "agent ran into a type error and suppressed it"
// pattern — sometimes legitimate at an FFI boundary, almost always
// type laundering when it piles up in one body.

/** TS-family gate. */
const TS_LANGUAGES: ReadonlySet<Language> = new Set(['typescript', 'tsx'] satisfies Language[]);

/** JS+TS-family gate — `computeMetrics` checks once to decide
 *  whether the comment-strip pre-pass is worth running. */
const JS_TS_FAMILY: ReadonlySet<Language> = new Set(['typescript', 'javascript', 'tsx', 'jsx'] satisfies Language[]);

/** `as any` or `as unknown as <identifier>`. The second form
 *  ("double cast") is the canonical agent suppression — it tells
 *  the compiler "trust me twice." Trailing identifier on the
 *  unknown form prevents matching the prefix of an unrelated
 *  statement. */
export const TS_ANY_CAST_RE = /\bas\s+(?:any\b|unknown\s+as\s+[A-Za-z_$])/g;

/** Count `as any` / `as unknown as X` casts in a TS body. */
export function countTsAnyCast(bodySource: string, language: Language): number {
  if (!TS_LANGUAGES.has(language)) return 0;
  let count = 0;
  TS_ANY_CAST_RE.lastIndex = 0;
  while (TS_ANY_CAST_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26: ts_ignore_suppression -------------------------------------
//
// ts-ignore / ts-expect-error suppression comments (the `// @ts-`
// directive shape). More explicit than `as any` (the author at
// least marked the suppression) but still papers over a real type
// problem.

export const TS_IGNORE_SUPPRESSION_RE = /\/\/\s*@ts-(?:ignore|expect-error)\b/g;

/** Count TS suppression comments in a TS body. */
export function countTsIgnoreSuppression(bodySource: string, language: Language): number {
  if (!TS_LANGUAGES.has(language)) return 0;
  let count = 0;
  TS_IGNORE_SUPPRESSION_RE.lastIndex = 0;
  while (TS_IGNORE_SUPPRESSION_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26: agent_debug_log -------------------------------------------
//
// `console.{log,error,warn,info,debug}(` calls in a body that does
// NOT also reference `process.env` or a DEBUG/VERBOSE/TRACE-style
// gate keyword. The canonical "agent left debug prints in
// production code" smell.
//
// False-positive guard: if the SAME body mentions `process.env` or
// a debug-flag keyword, assume the console calls are gated and
// skip. That covers the canonical `if (process.env.DEBUG) console.log(...)`
// shape AND helpers like `logDebug(msg)` whose body conditionally
// console.logs based on an env var.
//
// Path-based carve-outs (CLI bin, bench scripts whose console.log
// IS the legitimate output) aren't expressible at this layer — the
// per-symbol scan has no file path. If a CLI symbol trips this, fix
// at the call site (use a proper logger) or accept the finding.

export const AGENT_DEBUG_LOG_RE = /\bconsole\.(?:log|error|warn|info|debug)\s*\(/g;
// The keyword alternatives match inside SCREAMING_SNAKE compounds too
// (DEBUG_DIAGNOSTICS, APP_DEBUG, LOG_VERBOSE): `\b` alone can't cross an
// underscore (it's a word character), which silently missed the most common
// real-world flag NAMES. This also covers non-Node runtimes (Cloudflare
// Workers / Deno read `env.DEBUG_*` bindings, not process.env) — the intent
// marker is the keyword, not the mechanism that delivers it.
const DEBUG_FLAG_GATE_RE = /\bprocess\.env\b|(?:\b|_)(?:DEBUG|VERBOSE|TRACE)(?:\b|_)/;
const AGENT_DEBUG_LOG_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/**
 * Count ungated `console.*` calls. Two views of the body are used:
 *  - `rawBody` (with comments) for the gate — so a comment like
 *    `// promoted to console.error so visible without DEBUG env`
 *    correctly suppresses the finding (the human has documented
 *    intent).
 *  - `codeBody` (comments stripped) for the count — so example
 *    `console.log()` snippets inside JSDoc don't false-trip.
 *
 * Both views are passed in by the caller; {@link computeMetrics}
 * already computes them once per symbol.
 */
export function countAgentDebugLog(rawBody: string, codeBody: string, language: Language): number {
  if (!AGENT_DEBUG_LOG_LANGUAGES.has(language)) return 0;
  if (DEBUG_FLAG_GATE_RE.test(rawBody)) return 0;
  let count = 0;
  AGENT_DEBUG_LOG_RE.lastIndex = 0;
  while (AGENT_DEBUG_LOG_RE.exec(codeBody) !== null) count++;
  return count;
}

// ---- G26: incomplete_marker -----------------------------------------
//
// Incomplete-work markers in comments + the
// `throw new Error('not implemented')` shape. Universal across
// languages (comment-marker conventions are shared). The canonical
// "agent stubbed it and moved on" pattern.

/** Marker keyword regex. Word boundaries on both sides so prefixed or
 *  suffixed marker-like words don't false-match. */
export const INCOMPLETE_MARKER_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/g;

/** Explicit "not implemented" throw — Python's `NotImplementedError`,
 *  JS / TS `throw new Error('not implemented')`, etc. Case-insensitive
 *  on the message string so `'Not Implemented'` / `'NOT IMPLEMENTED'`
 *  also match. */
export const NOT_IMPLEMENTED_RE = /\b(?:NotImplementedError\b|throw\s+new\s+Error\s*\(\s*['"`]\s*not\s+implemented)/gi;

/** Count incomplete-marker occurrences in any-language body. */
export function countIncompleteMarker(bodySource: string): number {
  let count = 0;
  INCOMPLETE_MARKER_RE.lastIndex = 0;
  while (INCOMPLETE_MARKER_RE.exec(bodySource) !== null) count++;
  NOT_IMPLEMENTED_RE.lastIndex = 0;
  while (NOT_IMPLEMENTED_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26: dynamic_eval ----------------------------------------------
//
// `eval(...)` or `new Function(...)` calls. Both are dynamic
// code-generation — agents reach for this when they can't figure out
// how to call a method statically. Critical security smell when the
// argument is user-derived.

export const DYNAMIC_EVAL_RE = /\b(?:eval\s*\(|new\s+Function\s*\()/g;
const DYNAMIC_EVAL_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/** Count `eval(...)` / `new Function(...)` in a JS/TS body. */
export function countDynamicEval(bodySource: string, language: Language): number {
  if (!DYNAMIC_EVAL_LANGUAGES.has(language)) return 0;
  let count = 0;
  DYNAMIC_EVAL_RE.lastIndex = 0;
  while (DYNAMIC_EVAL_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26: insecure_hash ---------------------------------------------
//
// `createHash('md5')` / `createHash('sha1')`. Both have known
// collision attacks; modern code should use sha256+. Case-insensitive
// on the algorithm name (`'MD5'` / `'Sha1'` also match).

export const INSECURE_HASH_RE = /\bcreateHash\s*\(\s*['"`](?:md5|sha1)\b/gi;
const INSECURE_HASH_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/** Count broken-for-security `createHash` calls in a JS/TS body. */
export function countInsecureHash(bodySource: string, language: Language): number {
  if (!INSECURE_HASH_LANGUAGES.has(language)) return 0;
  let count = 0;
  INSECURE_HASH_RE.lastIndex = 0;
  while (INSECURE_HASH_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26: random_for_security ---------------------------------------
//
// `Math.random()` calls inside a body that also mentions a
// security-context keyword. `Math.random()` is NOT cryptographically
// secure — agents routinely reach for it instead of
// `crypto.randomBytes()`. The keyword gate bounds the false-positive
// rate (a math util that happens to call Math.random and use `id`
// in a variable name doesn't get flagged unless it ALSO mentions a
// security-shape word).
//
// Keyword set is deliberately narrower than the brief's suggestion:
// raw `key`/`id` would trip on every `Map.get(key)` / `array[id]`.
// We use phrases that strongly imply security context.

export const MATH_RANDOM_RE = /\bMath\.random\s*\(\s*\)/g;
export const SECURITY_KEYWORD_RE =
  /\b(?:token|secret|password|nonce|salt|csrf|sessionId|session_id|authToken|auth_token|apiKey|api_key|privateKey|private_key|accessKey|access_key)\b/i;
const RANDOM_FOR_SECURITY_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/**
 * Count `Math.random()` calls inside a body that mentions a
 * security-context keyword. The gate scans the RAW body (so a
 * comment mentioning `token` still triggers the security-context
 * check), and the count runs over the COMMENT-STRIPPED body (so
 * `Math.random()` examples in JSDoc don't false-trip).
 */
export function countRandomForSecurity(rawBody: string, codeBody: string, language: Language): number {
  if (!RANDOM_FOR_SECURITY_LANGUAGES.has(language)) return 0;
  if (!SECURITY_KEYWORD_RE.test(rawBody)) return 0;
  let count = 0;
  MATH_RANDOM_RE.lastIndex = 0;
  while (MATH_RANDOM_RE.exec(codeBody) !== null) count++;
  return count;
}

// ---- G26 Phase 2: http_no_timeout -----------------------------------
//
// `fetch(...)` / `axios.{get,post,put,delete,patch}(...)` / `axios(...)`
// calls in a body that doesn't mention `timeout` or `signal`. Without
// AbortController.signal or axios `timeout:`, a hung server can block
// the caller forever. Agents routinely forget the deadline.
//
// Detection is per-body, not per-call: if the SAME body contains
// fetch/axios + EITHER `timeout` OR `signal` keyword anywhere, the
// detector assumes the caller is deadline-aware and skips. Approximate
// but bounded — a body with multiple http calls where only ONE is
// gated will be skipped (false negative), but a body with NO gating
// keywords at all gets every http call flagged (true positive). The
// asymmetry favours fewer false alarms.

export const HTTP_CALL_RE = /\b(?:fetch|axios(?:\.(?:get|post|put|delete|patch|request|head|options))?)\s*\(/g;
const TIMEOUT_GATE_RE = /\b(?:timeout|signal)\b/;
const HTTP_LANGUAGES: ReadonlySet<Language> = new Set(['typescript', 'javascript', 'tsx', 'jsx'] satisfies Language[]);

/** Count fetch/axios calls in a body that has no timeout/signal
 *  reference. Returns 0 when the body isn't JS/TS OR the body
 *  contains a deadline-keyword. */
// A method/function DECLARATION named like an HTTP client is not a call:
// Cloudflare Durable Objects and service-worker handlers are literally named
// `fetch` (`async fetch(request) { ... }`), and a symbol's captured text
// includes its own declaration line — without this guard every fetch-protocol
// DO trips the rule on its own name. The guard checks the characters
// immediately before the match for a declaration keyword.
const HTTP_DECL_PREFIX_RE =
  /(?:\basync|\bfunction\s*\*?|\bstatic|\bpublic|\bprivate|\bprotected|\boverride|\bget|\bset)\s*$/;
/** Longest declaration keyword (+ generator star + spacing) — how far
 *  back the guard looks. */
const HTTP_DECL_LOOKBEHIND = 14;

export function countHttpNoTimeout(_rawBody: string, codeBody: string, language: Language): number {
  if (!HTTP_LANGUAGES.has(language)) return 0;
  // Gate on CODE, not the raw body: a comment merely promising a
  // future timeout must not mute the finding forever (field report
  // #2). empty_catch reads comments DELIBERATELY (a comment documents
  // intent for an empty block); here the only honest gate is an
  // actual timeout/signal in executable code.
  if (TIMEOUT_GATE_RE.test(codeBody)) return 0;
  let count = 0;
  HTTP_CALL_RE.lastIndex = 0;
  for (let m = HTTP_CALL_RE.exec(codeBody); m !== null; m = HTTP_CALL_RE.exec(codeBody)) {
    const before = codeBody.slice(Math.max(0, m.index - HTTP_DECL_LOOKBEHIND), m.index);
    if (HTTP_DECL_PREFIX_RE.test(before)) continue;
    count++;
  }
  return count;
}

// ---- G26 Phase 2: sql_string_concat ---------------------------------
//
// SQL queries built via template-literal interpolation or string
// concat are the canonical SQL-injection vector. Agents reach for
// templating when they don't know the parameterised-query API. The
// detector matches two shapes:
//
//   1. Template literal with `${` interpolation that contains a SQL
//      verb adjacent to the interpolation: e.g.,
//      ``\`SELECT * FROM ${table} WHERE id = ${id}\```.
//   2. String concat where a SQL-verb-bearing string is followed by
//      `+`: e.g., `'SELECT * FROM ' + table + ' WHERE ...'`.
//
// Both regexes are conservative — they only fire when a SQL verb
// (SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/TRUNCATE) is
// literally present in the string fragment. Parameterised forms like
// `db.prepare(\`SELECT ... WHERE id = @id\`).all({id})` use bound
// params, not interpolation, and don't trip.

const SQL_VERB_PATTERNS = [
  'SELECT',
  String.raw`INSERT\s+INTO`,
  'UPDATE',
  String.raw`DELETE\s+FROM`,
  String.raw`CREATE\s+TABLE`,
  String.raw`DROP\s+TABLE`,
  String.raw`ALTER\s+TABLE`,
  'TRUNCATE',
] as const;
const SQL_VERB_PATTERN = SQL_VERB_PATTERNS.join('|');

export const SQL_TEMPLATE_INTERPOLATION_RE = new RegExp('`[^`]*\\b(?:' + SQL_VERB_PATTERN + ')\\b[^`]*\\$\\{', 'gi');
export const SQL_STRING_CONCAT_RE = new RegExp(String.raw`['"][^'"]*\b(?:${SQL_VERB_PATTERN})\b[^'"]*['"]\s*\+`, 'gi');
const SQL_CONCAT_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);
/**
 * Two-pronged gate to suppress codebase-pattern false positives:
 *
 *  Gate A: body contains BOTH `.prepare(` AND a literal `'?'`. The
 *  canonical `(${kinds.map(()=>'?').join(',')})` placeholder-count
 *  idiom — bound-param-safe.
 *
 *  Gate B: every `${…}` interpolation in the body is a BARE
 *  identifier (`${dim}`, `${table}`, `${vecTable}`). Real injection
 *  typically uses member access or function calls
 *  (`${args.id}`, `${req.body.x}`, `${escapeStr(s)}`). Bare-identifier
 *  interpolations in SQL are overwhelmingly dynamic table/column
 *  names or migration DDL — patterns SQL forbids parameterising at
 *  all. False negative class: a body that copies user input to a
 *  local first (`const x = req.body.foo; \`...${x}\``) would skip;
 *  trade-off accepted because the alternative (firing on every
 *  legit dynamic table name in the codebase) drowns the signal.
 */
const SQL_PREPARED_QUERY_GATE_RE = /\.prepare\s*\(/;
const SQL_PLACEHOLDER_MARKER_RE = /['"`]\?['"`]/;
const SQL_INTERPOLATION_RE = /\$\{([^}]+)\}/g;
/** Bare identifier — no `.`, no `[`, no `(`, no operators. The
 *  intent is "the author is interpolating a captured local
 *  variable, presumably with a structural value (table name,
 *  placeholder string, dim number)." Member access (`obj.prop`),
 *  function calls, and expressions all suggest the value flows
 *  from user input or a computed source, so we DON'T skip those.
 *
 *  Call sites that need to interpolate a member-access value
 *  (e.g. `${row.tableName}`) should copy to a local first:
 *  `const tableName = row.tableName; … ${tableName}`. The detector
 *  then accepts the structural intent without false-flagging real
 *  injection risk. */
const BARE_IDENTIFIER_RE = /^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*$/;

/** True when every `${…}` interpolation within `templateBody`
 *  (the slice of source from an opening backtick to the matching
 *  closing one) is a bare identifier. Caller checks the gate
 *  per-template — looking at the whole body's interpolations
 *  conflates SQL templates with unrelated string templates (e.g.
 *  an error message `\`migration: ${JSON.stringify(x)}\`` would
 *  drag a `JSON.stringify(...)` call into the gate). */
function allInterpolationsInTemplateAreBare(templateBody: string): boolean {
  SQL_INTERPOLATION_RE.lastIndex = 0;
  let saw = false;
  let m: RegExpExecArray | null;
  while ((m = SQL_INTERPOLATION_RE.exec(templateBody)) !== null) {
    saw = true;
    if (!BARE_IDENTIFIER_RE.test(m[1] ?? '')) return false;
  }
  return saw;
}

/** Extract the FULL template literal that contains `startIdx` — the
 *  scanner steps backwards to find the opening backtick and
 *  forwards to find the matching closing one (template literals
 *  don't nest, so the next unescaped backtick closes). Used by the
 *  SQL detector to scope the bare-identifier gate to one template
 *  at a time. */
function extractTemplateAroundMatch(bodySource: string, matchStart: number, matchEnd: number): string {
  let open = matchStart;
  while (open > 0 && bodySource[open] !== '`') open--;
  let close = matchEnd;
  while (close < bodySource.length && bodySource[close] !== '`') close++;
  return bodySource.slice(open, close + 1);
}

/** Count SQL-injection-shape strings in a JS/TS body. Sum of both
 *  patterns. Two gates suppress the codebase's known-safe
 *  false-positive classes:
 *
 *    Gate 1 (body-level): prepared-query placeholder-count idiom
 *    (.prepare(...) + literal '?').
 *    Gate 2 (per-template): only count a SQL template if it
 *    contains a non-bare-identifier interpolation. Bare identifiers
 *    like `${table}` / `${dim}` / `${cols}` are structural refs to
 *    captured locals — the codebase's pattern for unavoidable
 *    table-name / column-list interpolation.
 *
 *  String concat (the `'…SELECT…' +` shape) always counts — it's
 *  the canonical injection vector with no legitimate cousin. */
export function countSqlStringConcat(bodySource: string, language: Language): number {
  if (!SQL_CONCAT_LANGUAGES.has(language)) return 0;
  if (SQL_PREPARED_QUERY_GATE_RE.test(bodySource) && SQL_PLACEHOLDER_MARKER_RE.test(bodySource)) return 0;
  let count = 0;
  SQL_TEMPLATE_INTERPOLATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQL_TEMPLATE_INTERPOLATION_RE.exec(bodySource)) !== null) {
    const template = extractTemplateAroundMatch(bodySource, m.index, m.index + m[0].length);
    if (!allInterpolationsInTemplateAreBare(template)) count++;
  }
  SQL_STRING_CONCAT_RE.lastIndex = 0;
  while (SQL_STRING_CONCAT_RE.exec(bodySource) !== null) count++;
  return count;
}

// ---- G26 Phase 2: unsafe_json_parse ---------------------------------
//
// `JSON.parse(...)` calls in a body that has no `try` / `catch` block.
// Unhandled JSON throws on every malformed input — agents routinely
// forget the catch when round-tripping config / network payloads.
//
// Detection: gate on body containing `catch` (the keyword). If catch
// is present, the body has SOME error-handling apparatus; the
// detector trusts the author and skips. Coarse — a body with one
// catch and an unrelated JSON.parse not inside it will be skipped
// (false negative), but a body with multiple parses where some are
// guarded and some aren't tends to be cleaner than one with zero
// guards.

export const JSON_PARSE_RE = /\bJSON\.parse\s*\(/g;
const CATCH_GATE_RE = /\bcatch\b/;
const JSON_PARSE_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/** Count unguarded `JSON.parse(` calls in a JS/TS body. Returns 0 when
 *  the body has any `catch` block. */
export function countUnsafeJsonParse(rawBody: string, codeBody: string, language: Language): number {
  if (!JSON_PARSE_LANGUAGES.has(language)) return 0;
  if (CATCH_GATE_RE.test(rawBody)) return 0;
  let count = 0;
  JSON_PARSE_RE.lastIndex = 0;
  while (JSON_PARSE_RE.exec(codeBody) !== null) count++;
  return count;
}

// ---- G26 Phase 2: env_no_validation ---------------------------------
//
// `process.env.NAME` (dot-access) reads in a body that doesn't use
// a Zod schema (heuristic: presence of `z.` in the body). The
// codebase's intentional env-var pattern is BRACKET access
// (`process.env['NAME']`) — that's the "I know this is dynamic"
// opt-in. Dot-access is the agent-prone shape: grab it and use it
// without validation.

export const PROCESS_ENV_DOT_RE = /\bprocess\.env\.[A-Z_][A-Z0-9_]*\b/g;
const ZOD_USE_RE = /\bz\.\w/;
const ENV_VALIDATION_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
] satisfies Language[]);

/** Count dot-access `process.env.X` reads in a JS/TS body that has
 *  no Zod schema reference. */
export function countEnvNoValidation(rawBody: string, codeBody: string, language: Language): number {
  if (!ENV_VALIDATION_LANGUAGES.has(language)) return 0;
  if (ZOD_USE_RE.test(rawBody)) return 0;
  let count = 0;
  PROCESS_ENV_DOT_RE.lastIndex = 0;
  while (PROCESS_ENV_DOT_RE.exec(codeBody) !== null) count++;
  return count;
}

// ---- G26 Phase 2: empty_function_body -------------------------------
//
// Function / method bodies that are essentially empty: `{}`,
// `{ return; }`, `{ return undefined; }`, `{ return null; }`. The
// canonical "agent stubbed the signature and moved on" smell.
//
// Skipped when the body has any non-trivial comment content
// (documenting the no-op IS intent — silentLogger.debug etc.).
// Returns 1 if the body is empty, 0 otherwise (it's a per-body
// classification, not a count).

/** Tokens that count as "noise" — whitespace + braces + simple
 *  return statements. If the body source contains ONLY these (and
 *  no comment lines with content), it's empty. */
const EMPTY_BODY_RE = /^\s*\{?\s*(?:return\s*(?:undefined|null)?\s*;?\s*)?\}?\s*$/;
/** Bodies with a comment line that has any non-comment-marker
 *  content document an intentional no-op (silentLogger, abstract
 *  override, protocol conformance). Skip those. */
const NON_TRIVIAL_COMMENT_RE = /\/[/*][^\n]*[A-Za-z][^\n]*/;

/** 1 if the body is empty per {@link EMPTY_BODY_RE} AND has no
 *  documenting comment. 0 otherwise. */
export function countEmptyFunctionBody(bodySource: string): number {
  if (NON_TRIVIAL_COMMENT_RE.test(bodySource)) return 0;
  return EMPTY_BODY_RE.test(bodySource) ? 1 : 0;
}

/** Push children of `node` onto the DFS stack at `depth`. Children are
 *  pushed in REVERSE so LIFO `pop()` returns them in source order.
 *  B18 (2026-05-23) — read via bulk `node.children` (one boundary cross,
 *  O(n)), then index the resulting JS array. */
function pushAstChildren(stack: Array<{ node: TsNode; depth: number }>, node: TsNode, depth: number): void {
  const children = node.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child) stack.push({ node: child, depth });
  }
}

/**
 * True when a Go `if_statement` is a nil-comparison error-check
 * (`if err != nil { ... }` or `if x == nil { ... }`). Detection is
 * shape-only: the if's immediate child is a `binary_expression`
 * whose operands include a `nil` literal. Used by {@link computeMetrics}
 * to suppress the +1 cyclomatic that this idiom would otherwise add —
 * Go's explicit error returns force these on every fallible call, so
 * counting them produces scores that don't match the gocyclo /
 * golangci-lint convention.
 */
function isGoNilComparisonIfStatement(ifNode: TsNode): boolean {
  const firstChild = ifNode.namedChildren[0] ?? null;
  if (firstChild?.type !== 'binary_expression') return false;
  // B18 (2026-05-23) — bulk `namedChildren` over indexed `namedChild(i)`.
  for (const c of firstChild.namedChildren) {
    if (c?.type === 'nil') return true;
  }
  return false;
}

interface TallyLiteralsArgs {
  k: string;
  node: TsNode;
  acc: { magic: number; url: number };
  language: Language;
}

/** Tally magic-number / hardcoded-url occurrences for one literal node. */
function tallyLiterals(args: TallyLiteralsArgs): void {
  const { k, node, acc, language } = args;
  if (NUMBER_LITERAL_KINDS.has(k)) {
    const text = node.text;
    if (text && isMagicNumber(text, language)) acc.magic++;
  }
  if (STRING_LITERAL_KINDS.has(k)) {
    const text = node.text;
    if (text && URL_LITERAL_RE.test(text)) acc.url++;
  }
}

/**
 * Compute metrics for a symbol body. Walks the AST iteratively so deep
 * trees don't blow the JS stack. Returns conservative numbers when the
 * language has no LangMap entry — caller can decide whether to emit.
 */
interface ComputeMetricsArgs {
  bodyNode: TsNode;
  language: Language;
  startLine: number;
  endLine: number;
}

export function computeMetrics(args: ComputeMetricsArgs): SymbolMetrics {
  const { bodyNode, language, startLine, endLine } = args;
  const loc = Math.max(0, endLine - startLine + 1);
  const map = getLangMap(language);
  if (!map) return emptyMetrics(loc);

  const ast = computeAstWalkMetrics(bodyNode, map, language);
  // B17/B19/B20/B21 (2026-05-23) — textual-regex detectors over the
  // body source. ONE `node.text` call amortises to all four — the
  // same WASM round-trip the literal-tally branches above accept
  // once per literal.
  const textual = computeTextualDetectorMetrics(bodyNode.text, language);
  return {
    loc,
    paramCount: countParameters(bodyNode),
    ...ast,
    ...textual,
  };
}

interface AstWalkMetrics {
  cyclomatic: number;
  maxNesting: number;
  maxConditionalOperands: number;
  magicNumberCount: number;
  hardcodedUrlCount: number;
}

/**
 * AST-walk pass — computes the structural complexity metrics
 * (cyclomatic / maxNesting / maxConditionalOperands) plus the
 * literal-tally counts (`magicNumberCount` / `hardcodedUrlCount`)
 * by a single iterative DFS over `bodyNode`.
 */
function computeAstWalkMetrics(bodyNode: TsNode, map: LangMap, language: Language): AstWalkMetrics {
  let cyclomatic = CYCLOMATIC_BASE;
  let maxNesting = 0;
  let maxConditionalOperands = 0;
  const literals = { magic: 0, url: 0 };
  const stack: Array<{ node: TsNode; depth: number }> = [{ node: bodyNode, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const k = node.type;
    if (isCountedBranch({ node, nodeType: k, map, language })) cyclomatic++;
    if (map.nesting.has(k)) {
      const newDepth = depth + 1;
      if (newDepth > maxNesting) maxNesting = newDepth;
      pushAstChildren(stack, node, newDepth);
      continue;
    }
    if (map.conditional.has(k)) {
      const ops = countConditionalOperands(node, map);
      if (ops > maxConditionalOperands) maxConditionalOperands = ops;
    }
    tallyLiterals({ k, node, acc: literals, language });
    pushAstChildren(stack, node, depth);
  }
  return {
    cyclomatic,
    maxNesting,
    maxConditionalOperands,
    magicNumberCount: literals.magic,
    hardcodedUrlCount: literals.url,
  };
}

function isCountedBranch(args: { node: TsNode; nodeType: string; map: LangMap; language: Language }): boolean {
  const { node, nodeType, map, language } = args;
  if (!map.branching.has(nodeType)) return false;
  // Go err-nil idiom: `if err != nil { return err }` (and its
  // `== nil` happy-path twin) inflates cyclomatic by +1 per error
  // path without adding meaningful branching complexity.
  return !(language === 'go' && nodeType === 'if_statement' && isGoNilComparisonIfStatement(node));
}

interface TextualDetectorMetrics {
  accidentalQuadraticCount: number;
  emptyCatchCount: number;
  syncIoInAsyncCount: number;
  forofAwaitCount: number;
  tsAnyCastCount: number;
  tsIgnoreSuppressionCount: number;
  agentDebugLogCount: number;
  incompleteMarkerCount: number;
  dynamicEvalCount: number;
  insecureHashCount: number;
  randomForSecurityCount: number;
  httpNoTimeoutCount: number;
  sqlStringConcatCount: number;
  unsafeJsonParseCount: number;
  envNoValidationCount: number;
  emptyFunctionBodyCount: number;
}

/**
 * Body-text regex pass — runs every textual-regex detector
 * (B17/B19/B20/B21 anti-pattern tier + the 12 G26 agent-prone
 * detectors) against a single `bodyText` argument.
 *
 * Per-language gating happens INSIDE each counter so non-applicable
 * languages return 0 without compiling a regex.
 *
 * G26 detectors come in two shapes: code-shape detectors
 * (cast/log/eval/hash/random) strip comments first so JSDoc
 * examples + prose like "as any node" don't false-trip; comment-shape
 * detectors (ts_ignore_suppression, incomplete_marker) intentionally
 * scan raw text. The stripped form is computed once for JS/TS bodies
 * and reused. Phase 2 detectors take both raw + stripped so the gate
 * scans raw (a comment can suppress) while the count scans stripped
 * (JSDoc examples don't false-trip).
 */
function computeTextualDetectorMetrics(bodyText: string, language: Language): TextualDetectorMetrics {
  const isJsTs = JS_TS_FAMILY.has(language);
  const codeOnlyBody = isJsTs ? stripJsComments(bodyText) : bodyText;
  return {
    accidentalQuadraticCount: countAccidentalQuadratic(bodyText, language),
    emptyCatchCount: countEmptyCatch(bodyText),
    syncIoInAsyncCount: countSyncIoInAsync(bodyText, language),
    forofAwaitCount: countForofAwait(bodyText, language),
    tsAnyCastCount: countTsAnyCast(codeOnlyBody, language),
    tsIgnoreSuppressionCount: countTsIgnoreSuppression(bodyText, language),
    agentDebugLogCount: countAgentDebugLog(bodyText, codeOnlyBody, language),
    incompleteMarkerCount: countIncompleteMarker(bodyText),
    dynamicEvalCount: countDynamicEval(codeOnlyBody, language),
    insecureHashCount: countInsecureHash(codeOnlyBody, language),
    randomForSecurityCount: countRandomForSecurity(bodyText, codeOnlyBody, language),
    httpNoTimeoutCount: countHttpNoTimeout(bodyText, codeOnlyBody, language),
    sqlStringConcatCount: countSqlStringConcat(codeOnlyBody, language),
    unsafeJsonParseCount: countUnsafeJsonParse(bodyText, codeOnlyBody, language),
    envNoValidationCount: countEnvNoValidation(bodyText, codeOnlyBody, language),
    emptyFunctionBodyCount: countEmptyFunctionBody(bodyText),
  };
}

/**
 * Tree-sitter node types that represent literal numbers across the
 * supported languages. Kept conservative — only types that are
 * unambiguously a numeric literal in expression position.
 */
const NUMBER_LITERAL_KINDS: ReadonlySet<string> = new Set([
  'number', // typescript / javascript / tsx / jsx
  'numeric_literal', // python / rust / php
  'integer_literal', // rust / kotlin
  'float_literal', // rust / go
  'int_literal', // go
  'float_literal', // go (duplicate but harmless in a Set)
  'integer', // ruby
  'decimal_integer_literal', // java / kotlin
  'hex_integer_literal', // java / kotlin
  'real_literal', // c#
  'integer_literal', // c#
]);

/** Tree-sitter node types that represent string literals. */
const STRING_LITERAL_KINDS: ReadonlySet<string> = new Set([
  'string',
  'string_literal',
  'raw_string_literal',
  'interpreted_string_literal',
  'template_string',
]);

/**
 * URL detection — kept tight to avoid false positives. Matches a
 * scheme + `://` + at least one path char. Schemes deliberately
 * limited to the ones that actually represent network endpoints
 * worth flagging in source code.
 *
 * The first path char excludes `%`/`{`/`$` so format-string templates
 * (`fmt.Sprintf("http://%s", origin)`, `f"http://{host}"`,
 * `"http://${env}"`, `s3://%s/bucket`) don't get flagged as hardcoded
 * URLs — those are URL builders, not literal endpoints. The exclusion
 * applies to EVERY scheme in the list above (`wss://`, `ftp://`,
 * `s3://`, `gs://` all share it), not just `http(s)`. Exclusion is on
 * the first char after `://`, so real URLs with a percent-encoded path
 * segment (`http://example.com/a%20b`) still match because their first
 * char after `://` is alphanumeric.
 */
const URL_LITERAL_RE = /\b(?:https?|wss?|ftp|s3|gs):\/\/[^\s'"`)%{$][^\s'"`)]*/;

/**
 * Go-specific allow-list for the magic_number rule. Covers the constants
 * Go time / scaling helpers (`humanDuration`, `humanBytes`-style) most
 * commonly literal-encode: seconds-per-minute / minutes-per-hour,
 * hours-per-day, days-per-week / month / year, and the decimal / binary
 * scaling factors. Without this, every Go time-conversion function
 * trips magic_number at error severity even though every entry is a
 * well-known scale factor, not a project-specific constant.
 */
const GO_MAGIC_NUMBER_ALLOWLIST: ReadonlySet<string> = new Set(['60', '24', '7', '30', '365', '1000', '1024', '86400']);

/**
 * "Magic number" classifier. Returns true when a numeric literal is
 * worth flagging — anything that isn't in the small universal allow-
 * list of truly trivial constants (0, 1, -1, 2). Hex/binary/octal
 * literals are flagged unconditionally on the same theory: a value
 * worth writing in non-decimal base is rarely incidental.
 *
 * Rejects non-numeric text up-front: tree-sitter typescript reuses
 * the `number` node kind for the type identifier `number` (as in
 * `count: number`), and we don't want to flag every type annotation
 * as a magic literal. Same defence is cheap for any other grammar
 * that may overload a numeric kind with a non-digit identifier.
 *
 * `language` is optional and enables per-language allow-lists.
 * Currently only Go is special-cased — see {@link GO_MAGIC_NUMBER_ALLOWLIST}
 * for the additional scale-factor constants (60/24/7/30/365/1000/1024/86400)
 * suppressed under `language === 'go'`. Other languages and the
 * undefined case fall through to the universal rule only.
 */
function isMagicNumber(text: string, language?: Language): boolean {
  const trimmed = text.replaceAll('_', '').toLowerCase();
  // Must begin with a digit, a sign + digit, a leading-dot float
  // (`.5`), or a `0x`/`0b`/`0o` prefix — anything else is the
  // kind-overload case (the type identifier `number`) and isn't a
  // real numeric literal.
  if (!/^[-+]?(\d|\.\d|0[xbo])/.test(trimmed)) return false;
  if (trimmed === '0' || trimmed === '1' || trimmed === '-1' || trimmed === '2') return false;
  if (trimmed === '0.0' || trimmed === '1.0' || trimmed === '-1.0') return false;
  if (language === 'go' && GO_MAGIC_NUMBER_ALLOWLIST.has(trimmed)) return false;
  return true;
}

/**
 * Count formal parameters on a function/method declaration. Walks the
 * immediate children looking for a `formal_parameters` / `parameters`
 * / `parameter_list` node, then counts its named children.
 *
 * Returns 0 when the node has no recognisable parameter list (e.g.
 * arrow functions with a single shorthand identifier are counted as 1
 * directly).
 */
function countParameters(funcNode: TsNode): number {
  // Only DECLARATION-site parameter list kinds. `argument_list` is
  // intentionally excluded — that's a call-site node and including it
  // would make a function whose body contains a call to a 7-arg
  // function spuriously look like a 7-param function.
  const PARAM_LIST_KINDS = new Set([
    'formal_parameters',
    'parameters',
    'parameter_list',
    'parameter_declaration_list',
    'function_parameters',
  ]);
  // Single-identifier arrow function form: `x => ...`
  // tree-sitter for JS/TS gives the identifier as a direct child
  // of the arrow_function with no parameter list wrapper.
  // B18 (2026-05-23) — bulk `children` over indexed `child(i)`.
  const children = funcNode.children;
  if (funcNode.type === 'arrow_function' && children.length > 0) {
    const first = children[0];
    if (first?.type === 'identifier') return 1;
  }
  for (const child of children) {
    if (!child) continue;
    if (!PARAM_LIST_KINDS.has(child.type)) continue;
    return countNonCommentNamedChildren(child);
  }
  return 0;
}

/** Count named children skipping `comment` nodes (grammars sometimes
 *  surface comments between params as named children). Pulled out of
 *  {@link countParameters} so the inner counter loop doesn't sit
 *  4-deep under the outer for-of-children + if-PARAM_LIST_KINDS. */
function countNonCommentNamedChildren(parent: TsNode): number {
  // B18 (2026-05-23) — bulk `namedChildren` over indexed `namedChild(j)`.
  let count = 0;
  for (const p of parent.namedChildren) {
    if (!p) continue;
    if (p.type === 'comment') continue;
    count++;
  }
  return count;
}

/**
 * Count operands inside a conditional expression. The "operand" is
 * any node that contributes a truthiness check or value comparison —
 * roughly, anything that would show up in a boolean expression's
 * abstract syntax. Counts each boolean operator AND its operands so
 * a 3-clause `&&` chain returns 3, not 2.
 */
function countConditionalOperands(condNode: TsNode, map: LangMap): number {
  let count = 0;
  const stack: TsNode[] = [condNode];
  // Walk the conditional's children only — never descend into a
  // nested function body. `if (arr.find(x => x.a && x.b))` should
  // count the call/identifier operands in the outer test, not the
  // inner `&&` inside the lambda — that's a separate conditional
  // belonging to the lambda's own analysis.
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node !== condNode && FUNCTION_CONTAINER_KINDS.has(node.type)) continue;
    if (map.booleanOp.has(node.type) || map.conditionalOperand.has(node.type)) {
      if (
        node.childCount === 0 ||
        [
          'identifier',
          'member_expression',
          'attribute',
          'call',
          'call_expression',
          'field_access',
          'method_invocation',
          'selector_expression',
        ].includes(node.type)
      ) {
        count++;
        continue;
      }
    }
    // B18 (2026-05-23) — bulk `children`; reverse iteration preserves
    // LIFO source-order popping (same shape as `pushAstChildren`).
    const kids = node.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const child = kids[i];
      if (child) stack.push(child);
    }
  }
  // At least 1 — even a trivial `if (x)` has one operand.
  return Math.max(count, 1);
}

/**
 * Re-parse a file's source and find the tree-sitter node whose span
 * starts at the given line/column. Used to map a `nodes`-table row
 * (which has start_line/start_column) back to the AST node that
 * produced it.
 *
 * Returns null if the language has no parser available (e.g. WASM
 * grammar not loaded) or if no node starts at that exact position.
 */
/** Tree-sitter node kinds that count as a "function/method container"
 *  whose body we want to analyse. Cross-language; missing entries fall
 *  through to the start-position match heuristic. */
const FUNCTION_CONTAINER_KINDS = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'method',
  'function_definition',
  'function',
  'function_item',
  'method_declaration',
  'constructor_declaration',
  'generator_function_declaration',
]);

/**
 * Parse a file once. Callers analysing many symbols in the same file
 * should call this once and reuse the returned tree across
 * `findNodeInTree` invocations — re-parsing on every symbol exhausts
 * the WASM tree-sitter heap on large C/C++ files (hundreds of
 * "memory access out of bounds" crashes per indexAll on real
 * codebases).
 *
 * Returns null when the language has no loaded parser.
 */
export function parseSource(source: string, language: Language): Tree | null {
  const parser = getParser(language);
  if (!parser) return null;
  return parser.parse(source) ?? null;
}

/**
 * Locate the AST node corresponding to a symbol at `(line, column)`
 * inside a pre-parsed tree. See {@link findNodeAt} for the legacy
 * one-shot variant.
 */
export function findNodeInTree(tree: Tree, line: number, column: number): TsNode | null {
  // tree-sitter rows are 0-indexed; cartograph stores 1-indexed lines.
  const row = Math.max(0, line - 1);
  const target = tree.rootNode.descendantForPosition({ row, column }, { row, column });
  if (!target) return null;
  // descendantForPosition returns the smallest node that contains the
  // point — often a keyword like `function`. Walk up to the nearest
  // named ancestor that's a function/method container.
  let candidate: TsNode | null = target;
  while (candidate) {
    if (FUNCTION_CONTAINER_KINDS.has(candidate.type) && candidate.isNamed) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  // Fallback: the first named ancestor whose start matches the
  // requested position. Catches custom node kinds not in the set above.
  candidate = target;
  while (candidate) {
    if (candidate.isNamed && candidate.startPosition.row === row && candidate.startPosition.column === column) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  return target;
}

interface FindNodeAtArgs {
  source: string;
  language: Language;
  line: number;
  column: number;
}

export function findNodeAt(args: FindNodeAtArgs): TsNode | null {
  const { source, language, line, column } = args;
  const tree = parseSource(source, language);
  if (!tree) return null;
  return findNodeInTree(tree, line, column);
}

// -----------------------------------------------------------------------------
// Biomarker rules
// -----------------------------------------------------------------------------

/**
 * Threshold tables. Picked from the literature (McCabe '76, Lanza &
 * Marinescu's "Object-Oriented Metrics in Practice", CodeScene's
 * published thresholds) but conservative — we'd rather under-flag
 * than spam findings on a fresh codebase.
 *
 * Info tier dropped: the complexity-family rules are hard rule
 * violations counted from AST (lines / cyclomatic / nesting /
 * conditional operands) where the info threshold sits at the noise
 * floor — every emission was a function "barely above the line".
 * Industry-standard linters (ESLint `complexity` / `max-depth` /
 * `max-params`, SonarQube `S134` / `S138`, gocyclo, pylint) all
 * emit complexity findings as warning-or-higher, never info-only.
 * The `info` field is retained in the type for backward compat with
 * the SIMPLE_RULES table contract; severityFor returns null below
 * the warning threshold.
 */
/** Large method threshold — warning at 100 LoC, error at 200. Info
 *  tier collapsed onto warning per the threshold-table doc above. */
const T_LOC = { info: 100, warning: 100, error: 200 };
const T_CYC = { info: 15, warning: 15, error: 25 };
const T_NEST = { info: 5, warning: 5, error: 7 };
const T_COND = { info: 6, warning: 6, error: 8 };

function severityFor(value: number, t: { info: number; warning: number; error: number }): Severity | null {
  if (value >= t.error) return 'error';
  if (value >= t.warning) return 'warning';
  if (value >= t.info) return 'info';
  return null;
}

interface RuleContext {
  nodeId: string;
  language: Language;
  metrics: SymbolMetrics;
  /**
   * Optional prior LoC snapshot for this symbol, threaded in by the
   * biomarker orchestrator. When present, drives `recently_grew`.
   * Absent → no prior data; that biomarker doesn't fire.
   */
  prior?: { loc: number; ts: number } | undefined;
  /**
   * The timestamp the orchestrator considers "now" for this pass —
   * passed in (rather than read via Date.now() inside the rule) so
   * tests can assert on a controlled clock.
   */
  nowMs?: number | undefined;
}

// Long parameter list. Industry range spans strict-3 (ESLint
// `max-params` default + Clean Code "3 max") to lenient-7 (SonarQube
// `S107`, McConnell's *Code Complete*). Cartograph sits one notch
// lenient of the strict end: info at 4 surfaces the candidates,
// warning at 5 starts demanding a real reason, error at 7 matches
// the SonarQube "definitely too many" tier.
const T_PARAMS = { info: 4, warning: 5, error: 7 };
/** Magic numbers — generous threshold; 3+ unexplained constants almost always benefit from named constants. */
const T_MAGIC = { info: 3, warning: 5, error: 8 };
/** Accidental quadratic — even ONE Schlemiel loop is a real perf cost,
 *  but only escalates to error when many occurrences pile up in one
 *  symbol (rare; usually indicates a hot dispatch table that's been
 *  copy-pasted). The historical B14/B15 fix arc removed a large
 *  cluster of these in one go; the warning floor at one occurrence
 *  guards against silent reintroduction. */
const T_QUAD = { info: 1, warning: 1, error: 5 };
/** Empty catch — silently swallowed errors. ANY occurrence is a smell;
 *  document intent with a comment if intentional (the detector skips
 *  bodies with non-whitespace content). Escalates to error when 3+
 *  pile up in one symbol — a pattern of swallowing in a tight code
 *  region is rarely intentional. */
const T_EMPTY_CATCH = { info: 1, warning: 1, error: 3 };
/** Sync I/O in async body — blocks the event loop. Same shape as
 *  empty_catch: ANY occurrence is wrong (you wrote `async` for a
 *  reason); pile of 3+ in one body is alarming. */
const T_SYNC_IO = { info: 1, warning: 1, error: 3 };
/** for-of-await sequentialization — softer thresholds. Sometimes
 *  sequential is intentional for back-pressure or strict ordering.
 *  Info at 1 (flag for review), warning at 2, error at 5. */
const T_FOROF_AWAIT = { info: 1, warning: 2, error: 5 };
// ─── G26 agent-prone tier (Phase 1) ─────────────────────────────────
/** `as any` / `as unknown as X` — info at 2 (matching the codebase's
 *  count-based pattern: T_PARAMS uses 4, T_MAGIC uses 3 — single
 *  occurrences are too noisy for FFI-boundary code that legitimately
 *  needs one forced cast). Warn at 3 (clearly type laundering),
 *  error at 5 (the file is fighting the type system). */
const T_TS_ANY_CAST = { info: 2, warning: 3, error: 5 };
/** ts-ignore / ts-expect-error directives — explicit suppression.
 *  Warn at any occurrence; error at 3+ in one body. */
const T_TS_IGNORE = { info: 1, warning: 1, error: 3 };
/** Ungated `console.*` — left-in debug prints. Warn at 1, error at
 *  5+ (something is very wrong if 5+ stray console calls survived
 *  review in one symbol). */
const T_AGENT_DEBUG_LOG = { info: 1, warning: 1, error: 5 };
/** Incomplete-work markers + `not implemented` shape. Info at 1
 *  (each marker is worth surfacing), warn at 5 (the file has become
 *  a stub graveyard), error sentinel at 50 — effectively never
 *  fires on normal code, but bounds catastrophic regressions. */
const T_INCOMPLETE_MARKER = { info: 1, warning: 5, error: 50 };
/** `eval()` / `new Function()` — any occurrence is a critical
 *  security smell. All three severities at 1 means the highest
 *  (error) fires immediately. */
const T_DYNAMIC_EVAL = { info: 1, warning: 1, error: 1 };
/** `createHash('md5'|'sha1')` — warn at 1, error at 3+. Both are
 *  broken-for-security; warn vs error is a "could be a non-security
 *  use of md5 (etag, cache key)" vs "definitely many sites doing
 *  this wrong" distinction. */
const T_INSECURE_HASH = { info: 1, warning: 1, error: 3 };
/** `Math.random()` in a security-context body. Any occurrence is
 *  an error — false positives are bounded by the keyword gate. */
const T_RANDOM_FOR_SECURITY = { info: 1, warning: 1, error: 1 };
// ─── G26 Phase 2 thresholds ─────────────────────────────────────────
/** Ungated `fetch` / `axios` — warn at 1, error at 3+. Lone forgotten
 *  timeout is common; a cluster of three in one body says the author
 *  has no deadline discipline at all. */
const T_HTTP_NO_TIMEOUT = { info: 1, warning: 1, error: 3 };
/** SQL built via interpolation or concat — warn at 1, error at 2+.
 *  Even ONE shape is a real injection vector; multiple sites in one
 *  body usually means an entire layer routed wrong. */
const T_SQL_STRING_CONCAT = { info: 1, warning: 1, error: 2 };
/** Unguarded `JSON.parse(` — warn at 1, error at 3+. Same shape as
 *  `empty_catch`: one occurrence is a smell, a pile of 3+ in one
 *  body is alarming. */
const T_UNSAFE_JSON_PARSE = { info: 1, warning: 1, error: 3 };
/** Dot-access `process.env.X` — warn at 1, error at 3+. Matches the
 *  codebase's "use brackets when you mean it" convention. */
const T_ENV_NO_VALIDATION = { info: 1, warning: 1, error: 3 };
/** Empty function body — info at 1 only. Stub-and-move-on is a code
 *  smell worth flagging, but warning/error feels too aggressive
 *  given the noise (no-op overrides + protocol conformance trips
 *  legitimately). The info-tier signal is enough. */
const T_EMPTY_FUNCTION_BODY = { info: 1, warning: 999, error: 999 };

/**
 * Declarative rule table — one entry per single-metric biomarker.
 * `evaluateRules` iterates this once instead of repeating the
 * severityFor + push pattern eight times. Composite rules
 * (brain_method, hardcoded_url tier) stay inline because they
 * branch on multiple metrics or non-linear thresholds.
 */
const SIMPLE_RULES: ReadonlyArray<{
  biomarker: Finding['biomarker'];
  metric: keyof RuleContext['metrics'];
  thresholds: { info: number; warning: number; error: number };
}> = [
  { biomarker: 'large_method', metric: 'loc', thresholds: T_LOC },
  { biomarker: 'complex_method', metric: 'cyclomatic', thresholds: T_CYC },
  { biomarker: 'nested_complexity', metric: 'maxNesting', thresholds: T_NEST },
  { biomarker: 'complex_conditional', metric: 'maxConditionalOperands', thresholds: T_COND },
  { biomarker: 'long_parameter_list', metric: 'paramCount', thresholds: T_PARAMS },
  { biomarker: 'magic_number', metric: 'magicNumberCount', thresholds: T_MAGIC },
  // B17 — Schlemiel-pattern detector. Fires on the first occurrence so
  // accidental quadratic loops don't sneak back into the extraction
  // hot path. See {@link ACCIDENTAL_QUADRATIC_PATTERNS}.
  { biomarker: 'accidental_quadratic', metric: 'accidentalQuadraticCount', thresholds: T_QUAD },
  // B19 — empty catch clauses (swallowed errors).
  { biomarker: 'empty_catch', metric: 'emptyCatchCount', thresholds: T_EMPTY_CATCH },
  // B20 — sync I/O inside an async body.
  { biomarker: 'sync_io_in_async', metric: 'syncIoInAsyncCount', thresholds: T_SYNC_IO },
  // B21 — sequential await in for-of loop (Promise.all opportunity).
  { biomarker: 'forof_await', metric: 'forofAwaitCount', thresholds: T_FOROF_AWAIT },
  // G26 (2026-05-24c) — agent-prone tier, Phase 1. Each detector is a
  // textual-regex scan over the same body text (one WASM round-trip,
  // amortised across all seven), gated on language inside the
  // counter so non-applicable languages return 0 without compiling
  // a regex. See the `BIOMARKER_NAMES` JSDoc for the per-detector
  // rationale + the brief in `[[feedback_go_keyword]]` G26 entry.
  { biomarker: 'ts_any_cast', metric: 'tsAnyCastCount', thresholds: T_TS_ANY_CAST },
  { biomarker: 'ts_ignore_suppression', metric: 'tsIgnoreSuppressionCount', thresholds: T_TS_IGNORE },
  { biomarker: 'agent_debug_log', metric: 'agentDebugLogCount', thresholds: T_AGENT_DEBUG_LOG },
  { biomarker: 'incomplete_marker', metric: 'incompleteMarkerCount', thresholds: T_INCOMPLETE_MARKER },
  { biomarker: 'dynamic_eval', metric: 'dynamicEvalCount', thresholds: T_DYNAMIC_EVAL },
  { biomarker: 'insecure_hash', metric: 'insecureHashCount', thresholds: T_INSECURE_HASH },
  { biomarker: 'random_for_security', metric: 'randomForSecurityCount', thresholds: T_RANDOM_FOR_SECURITY },
  // G26 Phase 2 (2026-05-25) — five Tier-2 agent-prone detectors.
  // Same shape as Phase 1; raw-vs-stripped split inside each counter
  // for the gated detectors.
  { biomarker: 'http_no_timeout', metric: 'httpNoTimeoutCount', thresholds: T_HTTP_NO_TIMEOUT },
  { biomarker: 'sql_string_concat', metric: 'sqlStringConcatCount', thresholds: T_SQL_STRING_CONCAT },
  { biomarker: 'unsafe_json_parse', metric: 'unsafeJsonParseCount', thresholds: T_UNSAFE_JSON_PARSE },
  { biomarker: 'env_no_validation', metric: 'envNoValidationCount', thresholds: T_ENV_NO_VALIDATION },
  { biomarker: 'empty_function_body', metric: 'emptyFunctionBodyCount', thresholds: T_EMPTY_FUNCTION_BODY },
];

/**
 * Brain Method composite — a risk-weighted score that genuinely
 * combines size with structural complexity, instead of the prior
 * "all three of large/complex/nested fire at warning+" gate.
 *
 * Why the rewrite (post-refactor backlog #4): the old shape
 * mostly duplicated large_method + complex_method on the same
 * symbol — its `metric` was just LOC, so a 200-LOC flat dispatch
 * fired the same as a 200-LOC method with deep nested loops and
 * dense boolean conditions. The composite score below pulls the
 * shape signals (nesting, conditional density) into the metric so
 * "the actually-scary methods" rank above "the merely-large".
 *
 * Formula:
 *   score = (loc / 100) × (cyc / 10) ×
 *           max(1, nest / 3) × max(1, condOps / 4)
 *
 * Each factor is normalised at 1.0 around the middle of its
 * single-metric biomarker's threshold band:
 *   loc / 100      : 100 LOC = 1× (T_LOC.warning is 100)
 *   cyc / 10       : 10 cyclomatic = 1× (the 2026-05-10 floor lift
 *                    moved T_CYC.warning to 15; brain_method keeps
 *                    the historical /10 normaliser so its score
 *                    distribution is unchanged)
 *   nest / 3       : 3 levels = 1× (was T_NEST.info before raise)
 *   condOps / 4    : 4 operands = 1× (was T_COND.info before raise)
 *
 * The `max(1, ...)` floor on nesting and condOps prevents low
 * structural-shape values from depressing the LOC×CYC product —
 * we want LOC and CYC to be the dominant signals, with nesting
 * and conditional density acting as multipliers on top.
 *
 * Worked examples on a 200-LOC method:
 *   flat dispatch table (cyc=15, nest=2, cond=3):
 *     2.0 × 1.5 × 1.0 × 1.0 = 3.0   → no finding (below info gate)
 *   nested-loop monstrosity (cyc=25, nest=5, cond=8):
 *     2.0 × 2.5 × 1.67 × 2.0 = 16.7 → warning
 *
 * Gates: ignore methods that aren't large enough OR complex enough
 * on the underlying scalars to be candidates at all (prevents tiny
 * helpers from firing on density alone).
 *
 * Future work: include a shared-mutable-state proxy (let-binding
 * count, cross-block reassignments) once the AST analysis is
 * available — would catch the long-tail of methods that look
 * tractable on the surface but actually have hidden coupling.
 */
const T_BRAIN = { info: 5, warning: 10, error: 20 };
/** Below this LOC, the method is too small to be a brain method regardless of density. */
const BRAIN_LOC_GATE = 50;
/** Below this cyclomatic, no amount of LOC × density qualifies — the method has too few decisions to be brainy. */
const BRAIN_CYC_GATE = 8;

// Per-factor normalisers in the composite score: each is the value at
// which that factor contributes ~1.0 to the product, chosen to align
// with the corresponding single-metric biomarker's threshold band.
// Per-constant docs cite the value so the stale_doc rule's number-set
// check stays satisfied if values are tuned later.
/** LOC normaliser — 100 LOC contributes 1.0 (matches T_LOC.warning of 100). */
const BRAIN_LOC_NORM = 100;
/** Cyclomatic normaliser — cyclomatic of 10 contributes 1.0 (matches T_CYC.info of 10). */
const BRAIN_CYC_NORM = 10;
/** Nesting normaliser — 3 levels contributes 1.0 (textbook moderate-nesting threshold of 3). */
const BRAIN_NEST_NORM = 3;
/** Conditional-operand normaliser — 4 operands contributes 1.0 (matches T_COND.info of 4). */
const BRAIN_COND_NORM = 4;
/** Score multiplier — 10 yields 1-decimal-place rounding via Math.round(score * 10) / 10. */
const BRAIN_SCORE_DECIMALS = 10;

/** Composite risk score combining size, branchiness, nesting, and conditional density. */
function brainMethodScore(m: SymbolMetrics): number {
  const locFactor = m.loc / BRAIN_LOC_NORM;
  const cycFactor = m.cyclomatic / BRAIN_CYC_NORM;
  const nestFactor = Math.max(1, m.maxNesting / BRAIN_NEST_NORM);
  const condFactor = Math.max(1, m.maxConditionalOperands / BRAIN_COND_NORM);
  return locFactor * cycFactor * nestFactor * condFactor;
}

/** Map a composite score to a severity tier; null when the score is below the info threshold. */
function brainMethodSeverity(score: number): Severity | null {
  if (score >= T_BRAIN.error) return 'error';
  if (score >= T_BRAIN.warning) return 'warning';
  if (score >= T_BRAIN.info) return 'info';
  return null;
}

function evaluateBrainMethod(ctx: RuleContext): Finding | null {
  const m = ctx.metrics;
  if (m.loc < BRAIN_LOC_GATE || m.cyclomatic < BRAIN_CYC_GATE) return null;
  const score = brainMethodScore(m);
  const severity = brainMethodSeverity(score);
  if (!severity) return null;
  const rounded = Math.round(score * BRAIN_SCORE_DECIMALS) / BRAIN_SCORE_DECIMALS;
  return {
    nodeId: ctx.nodeId,
    biomarker: 'brain_method',
    severity,
    metric: rounded,
    detail: {
      score: rounded,
      loc: m.loc,
      cyclomatic: m.cyclomatic,
      maxNesting: m.maxNesting,
      maxConditionalOperands: m.maxConditionalOperands,
    },
  };
}

/**
 * Hardcoded URL severity tier — even one is worth surfacing (URLs
 * almost never are the right design). Scales with count to
 * distinguish a single placeholder from real proliferation.
 */
function evaluateHardcodedUrl(ctx: RuleContext): Finding | null {
  const count = ctx.metrics.hardcodedUrlCount;
  if (count === 0) return null;
  let severity: Severity = 'info';
  if (count >= 3) severity = 'error';
  else if (count >= 2) severity = 'warning';
  return { nodeId: ctx.nodeId, biomarker: 'hardcoded_url', severity, metric: count };
}

/**
 * recently_grew — flag a symbol whose LoC has jumped sharply since
 * the previous indexed snapshot, within a recent time window. The
 * insight (per the post-refactor backlog item #5): static `large_method`
 * flags evergreen-large symbols indistinguishably from actively-rotting
 * ones; rapid recent growth is the actionable refactor signal.
 *
 * Triggers when ALL of:
 *   - prior snapshot exists, with prior_loc >= RECENT_MIN_PRIOR_LOC
 *     (skip tiny symbols where 5 → 12 LoC isn't useful signal),
 *   - current_loc > prior_loc * RECENT_GROW_THRESHOLD,
 *   - (now - prior_ts) <= RECENT_WINDOW_MS.
 *
 * Severity ladder by growth ratio: 1.5–2.0x info, 2.0–3.0x warning,
 * 3.0x+ error. The metric on the finding is the ratio × 100 (an
 * integer percent), since callers expect `metric: number` and the
 * percent is the most-comparable form.
 */
const RECENT_GROW_THRESHOLD = 1.5;
const RECENT_MIN_PRIOR_LOC = 20;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Growth-ratio threshold (3×) escalating `recently_grew` to `error`.
 * A function that's tripled in 30 days is anomalous, even by
 * feature-add standards.
 */
const RECENT_GROW_ERROR_RATIO = 3;

/**
 * Growth-ratio threshold (2×) escalating `recently_grew` to
 * `warning`. A function that's doubled in 30 days warrants a closer
 * look but isn't necessarily a defect.
 */
const RECENT_GROW_WARNING_RATIO = 2;

/**
 * Multiplier converting a fractional growth ratio into the integer
 * percent surfaced as `metric` on the finding. Callers expect a
 * `metric: number` and percent is the most-comparable form.
 */
const RATIO_TO_PERCENT = 100;

function severityForGrowthRatio(ratio: number): Severity {
  if (ratio >= RECENT_GROW_ERROR_RATIO) return 'error';
  if (ratio >= RECENT_GROW_WARNING_RATIO) return 'warning';
  return 'info';
}

function evaluateRecentlyGrew(ctx: RuleContext): Finding | null {
  const prior = ctx.prior;
  if (!prior) return null;
  if (prior.loc < RECENT_MIN_PRIOR_LOC) return null;
  const now = ctx.nowMs ?? Date.now();
  if (now - prior.ts > RECENT_WINDOW_MS) return null;
  const cur = ctx.metrics.loc;
  if (cur <= prior.loc * RECENT_GROW_THRESHOLD) return null;
  const ratio = cur / prior.loc;
  const severity = severityForGrowthRatio(ratio);
  return {
    nodeId: ctx.nodeId,
    biomarker: 'recently_grew',
    severity,
    metric: Math.round(ratio * RATIO_TO_PERCENT),
    detail: {
      priorLoc: prior.loc,
      currentLoc: cur,
      priorTs: prior.ts,
      ratio: Math.round(ratio * RATIO_TO_PERCENT) / RATIO_TO_PERCENT,
    },
  };
}

/**
 * Run every biomarker rule over the metrics. Findings are returned
 * in priority order so callers can `findings[0]` for the dominant one.
 */
export function evaluateRules(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  for (const rule of SIMPLE_RULES) {
    const value = ctx.metrics[rule.metric];
    const sev = severityFor(value, rule.thresholds);
    if (!sev) continue;
    out.push({ nodeId: ctx.nodeId, biomarker: rule.biomarker, severity: sev, metric: value });
  }
  // Composite rules — order matters: brain_method goes between simple
  // rules and hardcoded_url to preserve the previous output ordering.
  // Splice it in just before long_parameter_list to keep the historical
  // priority order (loc / cyc / nest / cond / brain / params / magic / url).
  const brain = evaluateBrainMethod(ctx);
  if (brain) {
    const insertAt = out.findIndex((f) => f.biomarker === 'long_parameter_list');
    if (insertAt === -1) out.push(brain);
    else out.splice(insertAt, 0, brain);
  }
  const url = evaluateHardcodedUrl(ctx);
  if (url) out.push(url);
  const grew = evaluateRecentlyGrew(ctx);
  if (grew) out.push(grew);
  return out;
}

/** Detector-score band thresholds for the secrets_handling rule.
 *  Mirrors the 3-tier ladder docs below. */
/** Scores at or above 0.5 emit a warning. */
const SECRETS_WARNING_FLOOR = 0.5;
/** Scores at or above 0.7 escalate to error. */
const SECRETS_ERROR_FLOOR = 0.7;
/** Scale factor (× 100) that converts the floating-point detector
 *  score into the integer `metric` field every rule emits. */
const SECRETS_METRIC_SCALE = 100;

/**
 * secrets_handling — flag symbols that look like they read/write API
 * keys, JWTs, passwords, AWS access keys, env-secret reads, PII, or
 * embed long token literals (Stage 7 #1 — heuristic-first detector).
 *
 * Severity ladder is score-driven:
 *   - score >= SECRETS_ERROR_FLOOR (0.7) → error
 *     (strong signal — explicit secret name + crypto/env context)
 *   - score >= SECRETS_WARNING_FLOOR (0.5) → warning
 *   - else null  (single-keyword name match is too noisy)
 *
 * Threshold bumped 2026-05-10 from 0.3 to 0.5: single-pattern matches
 * at the 0.3 weight floor (one of api-key-name / password-name /
 * env-secret-read / pii-name fired alone) produced too many false
 * positives in real codebases — functions like `tokeniseQuoteAware`
 * (matches "token"), `normalizeTok`, `handlePascalTyperef`, anything
 * with a `key` parameter, etc. Industry-standard scanners (gitleaks,
 * trufflehog, detect-secrets) all require corroborating signals
 * before firing; the new floor matches.
 *
 * Real-secret scenarios still fire because they hit multiple patterns:
 * a function like `verifyJwt(token, secret)` triggers `jwt-pattern`
 * (0.3) + `api-key-name` (0.3) = 0.6 → warning. A function reading
 * `process.env.API_SECRET` and using it for HMAC triggers
 * `env-secret-read` (0.3) + `crypto-secret` (0.2) + `api-key-name`
 * (0.3) = 0.8 → error. Literal AWS keys + env reads gets the 0.6
 * AKIA boost on top.
 *
 * v1 scope: name + signature + docstring + summary + body.
 */
export function evaluateSecretsHandling(node: {
  id: string;
  name: string;
  signature?: string | null | undefined;
  docstring?: string | null | undefined;
  summary?: string | null | undefined;
  body?: string | undefined;
}): Finding | null {
  const result = detectSecretsHandling({
    name: node.name,
    signature: node.signature ?? null,
    body: node.body ?? '',
    summary: node.summary ?? node.docstring ?? null,
  });
  if (result.score < SECRETS_WARNING_FLOOR) return null;
  const sev: Severity = result.score >= SECRETS_ERROR_FLOOR ? 'error' : 'warning';
  return {
    nodeId: node.id,
    biomarker: 'secrets_handling',
    severity: sev,
    metric: Math.round(result.score * SECRETS_METRIC_SCALE),
    detail: { signals: result.signals, reasons: result.reasons },
  };
}

/**
 * stale_doc — flag a constant whose preceding-comment / JSDoc cites
 * numeric literals that don't appear in the constant's actual value.
 * Catches the highest-confidence drift case: a docstring saying
 * "γ=2 math" after the constant got bumped to 5, or "0.4 numbers"
 * after the value became 0.5.
 *
 * v1 scope: constants only (function/method JSDoc rot is too noisy
 * to flag without semantic NLP). The heuristic is intentionally
 * conservative — only fires when BOTH docstring and signature
 * contain at least one number AND the sets are disjoint. Returns
 * null in every other case.
 *
 * Numbers extracted via {@link extractNumbersFromText}; reads are
 * cheap (regex on short strings) so we don't bother caching.
 */
export function evaluateStaleDoc(node: {
  id: string;
  docstring?: string | undefined;
  signature?: string | undefined;
}): Finding | null {
  if (!node.docstring || !node.signature) return null;
  // A signature that hit the extraction cap (INIT_SIGNATURE_MAX in
  // tree-sitter-decls) carries the '...' overflow marker — numbers
  // cited from LATER in the value are invisible here, so a
  // disjoint-set verdict would be a guess, and the field report
  // (#2 item 5) showed exactly that guess firing on real code.
  if (node.signature.endsWith('...')) return null;
  if (REGEX_INITIALIZER_RE.test(node.signature)) return null;
  const docNums = extractNumbersFromText(node.docstring);
  const sigNums = extractNumbersFromText(node.signature);
  if (docNums.size === 0 || sigNums.size === 0) return null;
  for (const n of docNums) {
    if (sigNums.has(n)) return null; // any overlap → not drifted
  }
  return {
    nodeId: node.id,
    biomarker: 'stale_doc',
    severity: 'info',
    metric: docNums.size,
    detail: { docNumbers: [...docNums], sigNumbers: [...sigNums] },
  };
}

// Strip ISO-date sequences (YYYY-MM-DD) before any other extraction.
// Their digit triples (year / month / day) are never value claims
// about the constant they decorate. Without this, every session-
// handoff comment ("Updated 2026-05-10: ...") trips stale_doc.
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
// Strip parentheticals that contain approximation / example signals
// (`~`, `e.g.`, `for example`, `approximately`, `around`, `like`).
// Numbers in such contexts are illustrative or rationale, not value
// claims — flagging them as drift produces FPs on the very common
// pattern `value (~N units)` or `value (e.g., N units)`. Closes
// friction #67. Real value claims in parens (`(default: N)`,
// `(was N before)`) lack the signal token and are preserved.
const APPROX_PAREN_RE = /\([^()]*(?:~|≈|e\.g\.|for example|\bapproximately\b|\baround\b|\blike\b)[^()]*\)/gi;
// NOTE: tilde-led numbers OUTSIDE parens (`~5 for tier 2`) are kept
// deliberately — an approximate value claim still anchors overlap,
// and extra doc numbers can never cause a firing (the rule needs
// FULL disjoint). Stripping them broke FUZZY_EDIT_DIST_MAX, whose
// only value claim is `~5`.
// JS numeric separators (`5_000` in initializers) and prose
// thousands-spacing (`10 000 nodes`) both read as the plain number.
// The space form only collapses digit + exactly-three-digit groups;
// a spaced enumeration whose second item is 3 digits (`ports 80 443`)
// would falsely merge, but that shape is vanishingly rare in
// docstrings and accepted as a known limitation.
const DIGIT_SEPARATOR_RE = /(?<=\d)(?:_(?=\d)| (?=\d{3}\b))/g;
// Money shorthand: `$`-REQUIRED. Bare K/M/B suffixes are quantity
// rationale ("5M rows", "39K files") and model sizes ("-1B params"),
// not value claims; expanding them invented billion-scale claims on
// real code. The field-report cases were all money ($96K, $2.4M).
const SHORTHAND_RE = /(?<![\w#'-])\$(\d+(?:\.\d+)?)\s?([KkMmBb])\b/g;
const SHORTHAND_MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
// Tokenizer body: consume the WHOLE word-ish token, then judge it
// (see usage comment in extractNumbersFromText). The `\w-` lookbehind
// rejects hyphen-compound references (`audit-4`, `Friction-29`,
// `gpt-4`) — trailing numerals of an identifier, not value claims.
// En/em dashes deliberately SPLIT tokens: in a severity ladder like
// `1.5–2.0x info` the range START is the constant's value claim
// (RECENT_GROW_THRESHOLD's only anchor) and must stay countable.
const NUMBER_TOKEN_RE = /(?<![\w#'])(?<!\w-)-?\d+(?:\.\d+)?(?:[\w%-][\w.%-]*)?/;
// A consumed token containing anything beyond digits/dot is
// unit-suffixed (`50%`, `0.85in`) — skipped whole.
const NON_PLAIN_NUMBER_RE = /[^\d.]/;
// Identifier-style prefixes that commonly precede a non-value number
// reference (`per RFC 3986`, `bind to port 8080`).
const NUMBER_PREFIX_SKIP_RE = /\b(?:rfc|port|issue|pr|chapter|section|fig(?:ure)?|sec)\s+$/i;
// A SPACED time/size unit word after a plain number (`5 minutes`,
// `10 MB`) is the same measurement class the attached-suffix skip
// already drops (`0.85in`) — a measurement in OTHER units than the
// raw initializer, which a unit-blind comparison can't judge. The
// optional en/em-dash tail lets the unit govern a whole prose range
// (`~10–20 ms`): both endpoints are measurements, neither a value.
// Shape first (word after optional range tail), Set lookup second —
// a 30-way regex alternation buys nothing but complexity.
const UNIT_WORD_AFTER_RE = /^(?:\s?[–—]\s?\d+(?:\.\d+)?)?\s+([A-Za-z]+)/;
const UNIT_WORDS = new Set([
  'ms',
  'msec',
  'msecs',
  'millisecond',
  'milliseconds',
  's',
  'sec',
  'secs',
  'second',
  'seconds',
  'min',
  'mins',
  'minute',
  'minutes',
  'h',
  'hr',
  'hrs',
  'hour',
  'hours',
  'd',
  'day',
  'days',
  'week',
  'weeks',
  'byte',
  'bytes',
  'kb',
  'kib',
  'mb',
  'mib',
  'gb',
  'gib',
  'tb',
  'tib',
]);

/** True when the text right after a plain number reads as a spaced
 *  unit word (optionally across an en/em-dash range tail). */
function isMeasurementTail(tail: string): boolean {
  const m = UNIT_WORD_AFTER_RE.exec(tail);
  return m !== null && UNIT_WORDS.has((m[1] ?? '').toLowerCase());
}
// 4-digit integers in this range read as years, not value claims.
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
// A signature whose initializer is a regex literal carries pattern
// syntax (quantifiers, char classes — `/-[123]b\b/`), never numeric
// value claims; doc text for such constants cites example MATCHES
// (`-1b`/`-2b`), so the disjoint check is meaningless there.
const REGEX_INITIALIZER_RE = /=\s*\//;

/**
 * Pull standalone numeric literals out of free text. We're trying to
 * recover *value claims* about a constant — numbers that, if they
 * disagree with the actual value, signal docstring rot. Several
 * shapes get filtered out because they're never value claims:
 *   - word-adjacent (`v2`, `PR_DAMPING`, `RFC3986`)
 *   - issue refs (`#123`)
 *   - apostrophe-prefixed year refs (`McCabe '76`, `Lanza '82`)
 *   - 4-digit numbers in [1900, 2100] (`Released in 2024`)
 *   - ISO dates (`2026-05-10` — every digit run is a date part, not
 *     a value claim; previously caused FPs on session-handoff doc
 *     edits)
 *   - percentages (`50%`) — relative claims, not constant values
 *   - RFC / port-style refs (`per RFC 3986`, `bind to port 8080`) —
 *     identifier-like numbers that happen to be large
 *   - parenthetical approximations / examples (`(~85 MB)`,
 *     `(e.g., 12.5 GB)`, `(approximately 4 MB)`) — illustrative
 *     numbers, not value-of-this-constant claims (#67)
 *   - tilde/≈-led runs outside parens (`~10–20 ms`) — same
 *     approximation semantics (field report #2 item 5 follow-on)
 *   - spaced unit words (`5 minutes`, `10 MB`) — measurements in
 *     other units, same class as the attached-suffix skip
 *   - hyphen-compound references (`audit-4`, `Friction-29`) —
 *     trailing numerals of an identifier
 *   - compound-noun-modifier prefixes (`1000-name list`,
 *     `5-element array`) — count adjectives (#67)
 *
 * Returns canonical string forms — both `5` and `5.0` get added so
 * the disjoint-set check is robust to decimal-point styling.
 */
function extractNumbersFromText(text: string): Set<string> {
  const out = new Set<string>();
  let cleaned = text.replaceAll(ISO_DATE_RE, '').replaceAll(APPROX_PAREN_RE, '');
  // Normalize digit separators before tokenizing. NOTE: this is what
  // first made underscore-separated constants VISIBLE to this rule at
  // all (their signatures previously tokenized to nothing, silently
  // skipping the check).
  cleaned = cleaned.replaceAll(DIGIT_SEPARATOR_RE, '');

  addMoneyShorthandClaims(cleaned, out);
  addPlainNumberClaims(cleaned, out);
  return out;
}

/** Money/quantity shorthand expands to the spelled-out value so a
 *  doc claim can match the initializer's numerals (field report #2
 *  item 5). */
function addMoneyShorthandClaims(cleaned: string, out: Set<string>): void {
  for (const sm of cleaned.matchAll(SHORTHAND_RE)) {
    const base = parseStrictDecimalNumber(sm[1] ?? '');
    const mult = SHORTHAND_MULT[(sm[2] ?? '').toLowerCase()];
    if (base !== null && mult !== undefined) out.add(String(base * mult));
  }
}

/** Tokenizer: consume the WHOLE word-ish token, then judge it. The
 *  previous trailing-LOOKAHEAD let the regex backtrack INSIDE a
 *  rejected token — `0.85in` matched as `0`, inventing a value claim
 *  that was never written (field report #2 item 5). A token with any
 *  unit/identifier suffix (`50%`, `1.5x`, `1000-name`, `0.85in`) is
 *  skipped WHOLE: those name counts or measurements, not the value
 *  of this constant (friction #67 semantics preserved). */
function addPlainNumberClaims(cleaned: string, out: Set<string>): void {
  const re = new RegExp(NUMBER_TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[0];
    if (NON_PLAIN_NUMBER_RE.test(raw.startsWith('-') ? raw.slice(1) : raw)) continue; // unit-suffixed token
    if (isMeasurementTail(cleaned.slice(re.lastIndex))) continue; // spaced unit word — a measurement
    const before = cleaned.slice(0, m.index);
    if (NUMBER_PREFIX_SKIP_RE.test(before)) continue;
    const f = parseStrictDecimalNumber(raw);
    if (f !== null && Number.isInteger(f) && f >= YEAR_MIN && f <= YEAR_MAX) continue;
    out.add(raw);
    if (f !== null) out.add(String(f));
  }
}

/**
 * Aggregate findings into a single 1-10 Code Health score for a node
 * or a collection. Accepts any objects exposing `severity` so callers
 * can pass DB-shaped rows without re-mapping. The mapping is
 * conservative:
 *   - any error finding: -2 from baseline 10
 *   - any warning finding: -1
 *   - any info finding: -0.5
 *   - no findings: 10
 * Multiple findings of the same severity tier each subtract again,
 * with a floor of 1.
 */
/** Top-of-scale baseline; a project with no findings scores this. */
const HEALTH_SCORE_BASELINE = 10;
/** Lowest score the function will return — a deluge of errors floors here. */
const HEALTH_SCORE_FLOOR = 1;
/** Per-severity deductions applied each time a finding of the kind is seen. */
const HEALTH_SCORE_ERROR_DEDUCT = 2;
const HEALTH_SCORE_WARNING_DEDUCT = 1;
const HEALTH_SCORE_INFO_DEDUCT = 0.5;
/** Rounds the final score to one decimal place — readable headline integer-ish. */
const HEALTH_SCORE_ROUND_TENTHS = 10;

export function codeHealthScore(findings: ReadonlyArray<{ severity: Severity }>): number {
  if (findings.length === 0) return HEALTH_SCORE_BASELINE;
  let score = HEALTH_SCORE_BASELINE;
  for (const f of findings) {
    if (f.severity === 'error') score -= HEALTH_SCORE_ERROR_DEDUCT;
    else if (f.severity === 'warning') score -= HEALTH_SCORE_WARNING_DEDUCT;
    else score -= HEALTH_SCORE_INFO_DEDUCT;
  }
  return Math.max(HEALTH_SCORE_FLOOR, Math.round(score * HEALTH_SCORE_ROUND_TENTHS) / HEALTH_SCORE_ROUND_TENTHS);
}

export const _internalForTests = { countConditionalOperands, isMagicNumber };
