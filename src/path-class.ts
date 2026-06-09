/**
 * Unified path classification — the single source of truth for
 * "what kind of file is this?".
 *
 * The question used to be answered SIX divergent ways, each with its
 * own slightly-different regex set:
 *   - `utils.isTestPath`            (test + fixture dirs/suffixes)
 *   - `utils.isDiagnosticPath`      (scripts/bench/examples + some tests)
 *   - `mcp/tools/shared.isFixturePath` (anchored fixture dirs only)
 *   - `llm/dead-code.EXEMPT_PATH_PATTERNS` (test + script + bench)
 *   - `context/index.SCRIPT_PATH_RE`   (scripts/ only)
 *   - `search/query-utils.isTestFile`  (polyglot test conventions —
 *     the only one that knew Go / Python / Rust / JVM naming)
 * They drifted: a fix to one never reached the others, and several of
 * the 2026-05-15 friction-workout findings traced straight back to the
 * divergence. This module replaces all six — folding in `query-utils`'s
 * polyglot filename conventions so EVERY consumer (the `is_test` flag,
 * dead-code, biomarkers, context ranking) recognises a Go / Python /
 * Rust / JVM test file, not only a JavaScript one.
 *
 * `pathCategory(p)` assigns every project-relative path exactly ONE
 * category. Tools then declare which categories they care about —
 * either via the named predicates below or by switching on the
 * category directly (e.g. dead-code exempts test/script/benchmark but
 * deliberately keeps fixtures for its own `isExempt` callback).
 *
 * Classification stays a heuristic: `scripts/` can hold CI-critical
 * code, a `fixtures/` directory can be a production data module. The
 * bar — inherited from the predecessors — is "patterns very unlikely
 * to fire on production code", because every consumer uses this to
 * DOWN-RANK or EXCLUDE, never to delete. One shared heuristic beats
 * five divergent ones.
 */

export type PathCategory = 'production' | 'test' | 'fixture' | 'script' | 'benchmark';

/* Fixture directories / files: synthetic code that feeds a test or an
 * extraction suite. `docs/test-beds/` holds the per-language extraction
 * fixtures; a `fixtures/` directory and the `.fixture.` filename infix
 * are the generic conventions. Checked FIRST so a fixture named
 * `sample.test.ts` under `test-beds/` classifies as a fixture, not a
 * runnable test. */
const FIXTURE_PATTERNS: readonly RegExp[] = [/(^|\/)fixtures?\//i, /(^|\/)test-beds?\//i, /\.fixture\.[a-z0-9]+$/i];

/* Test files and their directories. Lots of fixture-shaped code lives
 * here (per-test setup helpers with no callers, assertion-driving mocks
 * with intentional unused interfaces) — production code-health bars
 * shouldn't be scored against it.
 *
 * cartograph indexes ~25+ languages (TypeScript, JS, Python, Go, Rust,
 * Java, C/C++, C#, PHP, Ruby, Swift, Kotlin, Scala, Dart, Lua, R,
 * ReScript, …), so test detection is keyed on CONVENTIONS, not
 * languages — each pattern below holds across every language that
 * follows it, the file extension is always left open (`[a-z0-9]+`),
 * and directory names match case-insensitively (.NET capitalises,
 * e.g. `Foo.Tests/`). Adding a new language usually needs NO change
 * here; only a genuinely new naming convention does — add it to the
 * right group below. */
const TEST_PATTERNS: readonly RegExp[] = [
  // ── Directory conventions ──
  /(^|\/)__tests__\//i,
  /(^|\/)__mocks__\//i,
  /(^|\/)tests?\//i,
  /(^|\/)specs?\//i,
  // `integration/` / `testing/` / `testlib/` are looser — a project
  // could use `integration/` for production adapter code. Kept because
  // the consumer only DOWN-RANKS / exempts (never deletes), and these
  // dirs hold test code far more often than not.
  /(^|\/)integration\//i,
  /(^|\/)testing\//i,
  /(^|\/)testlib\//i,
  // ── Filename conventions ──
  // Infix:  foo.test.ts / foo.spec.rb / foo.test.py
  /\.test\.[a-z0-9]+$/i,
  /\.spec\.[a-z0-9]+$/i,
  // Suffix: foo_test.go / foo_spec.rb / foo_test.rs
  // (Go, Python, Rust, Ruby, Lua/busted, ReScript, …)
  /_test\.[a-z0-9]+$/i,
  /_spec\.[a-z0-9]+$/i,
  // Prefix: test_foo.py / test-foo.R (Python, Ruby, R/testthat, …)
  // and a bare `test.<ext>`.
  /(^|\/)test[-_][^/]*$/i,
  /(^|\/)test\.[a-z0-9]+$/i,
  // CamelCase suffix: FooTest.java / FooTests.cs / FooSpec.scala /
  // FooTestCase.swift (JVM, .NET, Swift, Scala, …). Case-sensitive on
  // the convention word so a lower-case word ending in "test"/"spec"
  // — e.g. `latest.ts`, `apispec.ts` — does not match. An all-caps
  // acronym prefix is allowed (`APISpec.java`) — that catches
  // `HTTPTest.java`-style test classes; the cost is the occasional
  // DDD "specification" class read as a test, acceptable for a
  // down-rank heuristic (and `*Spec` IS a test under Spock).
  /[A-Za-z](Test|Tests|TestCase|Spec)\.[a-z0-9]+$/,
  // Standalone mock/fixture FILES that live inside production-looking
  // source directories rather than a dedicated test directory. A file
  // whose basename IS `mock.<ext>`, `mocks.<ext>`, `fixture.<ext>`, or
  // `fixtures.<ext>` is test-support code — not the canonical public API
  // — even when its path contains no `__tests__/` / `tests/` / `fixtures/`
  // segment. Example: `tokio/src/fs/mocks.rs` (private io mock helper).
  // Anchored at the final segment so `FooMocks.java`-style class files
  // are not caught (the CamelCase suffix pattern above handles those).
  // Case-insensitive for cross-language consistency (e.g. `Mocks.swift`).
  /(^|\/)mock\.[a-z0-9]+$/i,
  /(^|\/)mocks\.[a-z0-9]+$/i,
  /(^|\/)fixture\.[a-z0-9]+$/i,
  /(^|\/)fixtures\.[a-z0-9]+$/i,
];

/* Performance benchmarks. `benches/` is the Rust/Cargo convention. */
const BENCHMARK_PATTERNS: readonly RegExp[] = [/(^|\/)bench(es|marks?)?\//i];

/* Diagnostic / one-off code: demo runners, generators, example /
 * sample code. Written as flat top-level functions because that's the
 * most readable shape for an ad-hoc tool — no callers, deliberate
 * unused exports. Directory conventions, language-agnostic. */
const SCRIPT_PATTERNS: readonly RegExp[] = [
  /(^|\/)scripts?\//i,
  /(^|\/)examples?\//i,
  /(^|\/)samples?\//i,
  /(^|\/)demos?\//i,
  // Conventional repo-ROOT build/release tooling scripts (no leading dir).
  // These are tooling, not source-under-quality-gate — their console
  // output, sync I/O and bare JSON.parse are appropriate. Root-anchored so
  // `src/build.ts` (real code) is never caught.
  /^(?:publish|release|build|deploy|bundle|prepublish|postinstall)\.[mc]?[jt]s$/i,
];

/**
 * Classify a project-relative file path into exactly one category.
 *
 * Precedence (first match wins): fixture → test → benchmark → script
 * → production. Fixture leads so a `*.test.ts` file living under a
 * `test-beds/` / `fixtures/` directory is recognised as the fixture it
 * is rather than a runnable test.
 */
export function pathCategory(filePath: string): PathCategory {
  if (!filePath) return 'production';
  if (FIXTURE_PATTERNS.some((re) => re.test(filePath))) return 'fixture';
  if (TEST_PATTERNS.some((re) => re.test(filePath))) return 'test';
  if (BENCHMARK_PATTERNS.some((re) => re.test(filePath))) return 'benchmark';
  if (SCRIPT_PATTERNS.some((re) => re.test(filePath))) return 'script';
  return 'production';
}

/**
 * Test or fixture path — code that isn't production but exercises or
 * feeds it. The widest "is this a test" notion, and the one the
 * `is_test` file-table flag is derived from (so the flag now reflects
 * the polyglot filename conventions, not only JavaScript's).
 */
export function isTestPath(filePath: string): boolean {
  const c = pathCategory(filePath);
  return c === 'test' || c === 'fixture';
}

/** Strictly a fixture directory / file. */
export function isFixturePath(filePath: string): boolean {
  return pathCategory(filePath) === 'fixture';
}

/**
 * Non-production code that production code-health bars shouldn't be
 * scored against, and that retrieval should down-rank: tests,
 * fixtures, scripts, benchmarks — anything `pathCategory` doesn't call
 * `production`. This is the predicate `search`'s former `isTestFile`
 * folded into (context ranking calls it directly now).
 */
export function isDiagnosticPath(filePath: string): boolean {
  return pathCategory(filePath) !== 'production';
}

/**
 * Directory basenames that never contain project source — dependency
 * trees, build output, tool caches, VCS metadata, and cartograph's own
 * `.cartograph/` index dir.
 *
 * The single source of truth for "don't descend into this directory"
 * across the tree-walking tools (host discover,
 * `cartograph_changed_since`). Those two used to keep separate hand-
 * maintained sets that had silently drifted — one skipped `.turbo` but
 * not `.cartograph`, the other the reverse.
 *
 * NB: this is the *directory-name* skip-set. The indexer's far richer
 * `exclude` glob list in `default-config.ts` is a deliberately distinct,
 * curated artifact (anchored globs, file-name patterns like `*.min.js`,
 * framework-specific caches) and is intentionally NOT derived from this.
 */
export const NON_SOURCE_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.cartograph',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
]);
