/**
 * Tests-as-edges
 *
 * Convention-based test → subject file resolution. Walks every indexed
 * file, identifies test files via filename pattern, and resolves each
 * test to the source file(s) it tests. Resulting edges (kind: 'tests')
 * make `getTestsForFile(src)` and `getSubjectsOfTest(test)` one-call
 * lookups that previously required a grep through the codebase.
 *
 * Convention-only — does not look inside test bodies. Tests with no
 * obvious subject (multi-subject feature tests, project-wide harnesses)
 * are honestly left without edges rather than guessed at.
 */

import * as path from 'path';

/**
 * Source file extensions we treat as plausible test subjects.
 * Order matters: when both `foo.ts` and `foo.tsx` exist for a test
 * named `foo.test.tsx`, we prefer the matching extension first.
 */
const SOURCE_EXTS_BY_TEST_EXT: Record<string, string[]> = {
  ts: ['ts'],
  tsx: ['tsx', 'ts'],
  js: ['js'],
  jsx: ['jsx', 'js'],
  mjs: ['mjs', 'js'],
  cjs: ['cjs', 'js'],
  py: ['py'],
  rs: ['rs'],
  go: ['go'],
  rb: ['rb'],
  java: ['java'],
  kt: ['kt', 'kts'],
  cs: ['cs'],
  swift: ['swift'],
};

/**
 * Extract the "subject basename" from a test filename — i.e. the basename
 * of the source file we'd expect this test to be testing, with the
 * extension dropped. Returns null when the file isn't a test by any
 * recognized convention.
 *
 * Conventions handled:
 *   foo.test.{ts,tsx,js,jsx,mjs,cjs}        — JS/TS family (Jest, Vitest)
 *   foo.spec.{ts,tsx,js,jsx,mjs,cjs}        — same family, alt suffix
 *   test_foo.{py,rs}                        — Python pytest, Rust convention
 *   foo_test.{go,py,rs}                     — Go convention; alt for Python/Rust
 *   foo_{spec,test}.rb                      — Ruby (RSpec, Minitest)
 *   FooTest.{java,kt,cs,swift}              — xUnit
 *   FooTests.{java,kt,cs,swift}             — xUnit (plural)
 *   FooSpec.{swift,kt}                      — Quick (Swift), Spek (Kotlin)
 */
export function testSubjectBasename(filePath: string): string | null {
  const base = path.basename(filePath);

  // foo.test.ts / foo.spec.ts (JS/TS family)
  let m = base.match(/^(.+?)\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/);
  if (m) return m[1]!;

  // test_foo.py / test_foo.rs
  m = base.match(/^test_(.+?)\.(py|rs)$/);
  if (m) return m[1]!;

  // foo_test.go / foo_test.py / foo_test.rs
  m = base.match(/^(.+?)_test\.(go|py|rs)$/);
  if (m) return m[1]!;

  // foo_spec.rb / foo_test.rb
  m = base.match(/^(.+?)_(spec|test)\.rb$/);
  if (m) return m[1]!;

  // FooTest.java / FooTests.java (xUnit-style; trailing s optional)
  m = base.match(/^(.+?)Tests?\.(java|kt|cs|swift)$/);
  if (m) return m[1]!;

  // FooSpec.swift / FooSpec.kt (Quick / Spek)
  m = base.match(/^(.+?)Spec\.(swift|kt)$/);
  if (m) return m[1]!;

  return null;
}

/**
 * True when `filePath` matches any test convention we recognize.
 */
export function isTestFile(filePath: string): boolean {
  return testSubjectBasename(filePath) !== null;
}

/**
 * Resolve a test file's subject source file(s) within the project. Returns
 * an array (zero, one, or more) of paths drawn from `allFiles`.
 *
 * Strategy, applied in order; later steps run only if earlier ones miss:
 *
 *   1. Co-located: `path/foo.test.ts` → `path/foo.ts` or `path/foo/index.ts`
 *      (handles e.g. `src/sync/watcher.test.ts` next to `src/sync/watcher.ts`).
 *   2. Mirrored layout: walk up dropping `__tests__` / `tests` / `spec`,
 *      then look for the subject directly or under `<dir>/index.<ext>`
 *      (handles `__tests__/sync.test.ts` → `src/sync/index.ts`).
 *   3. Common source roots: when the test sits at project root (no
 *      mirrored target), try `src/`, `lib/`, `app/`, `packages/`.
 *   4. Anywhere by basename: if still unresolved, find files by basename
 *      match and pick the one whose directory shares the longest path
 *      prefix with the test file.
 *
 * Returns an empty array when the test has no obvious subject. We
 * deliberately do NOT guess — feature-themed tests like `security.test.ts`
 * legitimately span multiple files and shouldn't be edged to one of them.
 */
export function findTestSubjects(testFile: string, allFiles: Set<string>): string[] {
  const subject = testSubjectBasename(testFile);
  if (!subject) return [];

  const dir = path.posix.dirname(testFile);
  const testExt = path.extname(testFile).slice(1).toLowerCase();
  const sourceExts = SOURCE_EXTS_BY_TEST_EXT[testExt] ?? [testExt];
  const candidates = new Set<string>();

  // 1. Co-located.
  addSubjectMatchesIn({ dir, subject, sourceExts, allFiles, candidates, excludeTestFile: testFile });

  // 2 + 3. Mirror the test path back to a source-tree path, then look there
  // (or in common source roots when the mirror collapses to empty).
  for (const root of mirroredSourceRoots(dir)) {
    addSubjectMatchesIn({ dir: root, subject, sourceExts, allFiles, candidates });
  }

  // 4. Last resort: scan all files by basename and pick the one whose
  // directory shares the longest path prefix with the test.
  if (candidates.size === 0) {
    const closest = findClosestBasenameMatch({ allFiles, subject, sourceExts, testDir: dir, testFile });
    if (closest) candidates.add(closest);
  }

  return [...candidates];
}

/**
 * Add `${dir}/${subject}.${ext}` and `${dir}/${subject}/index.${ext}` to
 * `candidates` when those files exist in `allFiles`, for each source-ext
 * the test extension can target. Pass `excludeTestFile` to skip a path
 * that would resolve back to the test itself (the co-located branch).
 */
interface AddSubjectMatchesArgs {
  dir: string;
  subject: string;
  sourceExts: readonly string[];
  allFiles: Set<string>;
  candidates: Set<string>;
  /** Skip a path that would resolve back to the test itself. Used by the co-located branch. */
  excludeTestFile?: string | null;
}

function addSubjectMatchesIn(args: AddSubjectMatchesArgs): void {
  const { dir, subject, sourceExts, allFiles, candidates, excludeTestFile = null } = args;
  for (const ext of sourceExts) {
    const direct = path.posix.join(dir, `${subject}.${ext}`);
    if (allFiles.has(direct) && direct !== excludeTestFile) candidates.add(direct);
    // The `indexed` path intentionally has no exclude guard: a test named
    // `foo.test.ts` can never resolve to `foo/index.ts` (different file
    // shape), so no self-edge is possible.
    const indexed = path.posix.join(dir, subject, `index.${ext}`);
    if (allFiles.has(indexed)) candidates.add(indexed);
  }
}

/**
 * Strip `__tests__` anywhere and a leading/interior `tests`/`test`/`spec`
 * segment. The leading-anchored pass catches top-level test directories
 * like `tests/test_handlers.py` that the slash-prefixed pattern alone
 * would miss (no leading `/`). Falls back to a small set of common
 * source roots (`src`, `lib`, …) when the mirror collapses to empty.
 */
function mirroredSourceRoots(dir: string): readonly string[] {
  const mirrored = dir
    .replaceAll(/__tests__\/?/g, '')
    .replace(/^(?:tests?|spec)(\/|$)/, '')
    .replaceAll(/\/(?:tests?|spec)(\/|$)/g, '/')
    .replace(/\/+$/, '');
  return mirrored ? [mirrored] : ['.', 'src', 'lib', 'app', 'packages'];
}

/**
 * Scan every file in the index for a basename match on the test's
 * subject and pick the one whose directory shares the longest path
 * prefix with the test file. Returns null when no source-extension
 * basename match exists.
 */
interface FindClosestBasenameArgs {
  allFiles: Set<string>;
  subject: string;
  sourceExts: readonly string[];
  testDir: string;
  testFile: string;
}

function findClosestBasenameMatch(args: FindClosestBasenameArgs): string | null {
  const { allFiles, subject, sourceExts, testDir, testFile } = args;
  const matches: string[] = [];
  for (const f of allFiles) {
    const ext = path.extname(f).slice(1).toLowerCase();
    if (!sourceExts.includes(ext)) continue;
    const fBase = path.basename(f, path.extname(f));
    if (fBase === subject && f !== testFile) matches.push(f);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  return pickByLongestPathPrefix(testDir, matches);
}

/**
 * F#56 (2026-05-26): Rust-specific test conventions.
 *
 * Cargo has two dominant patterns that the filename-based
 * convention finder above doesn't reach:
 *
 *   1. **Inline same-file tests** — `#[cfg(test)] mod tests { … }`
 *      declared inside a production source file. The file IS both
 *      production code and its own tests. The subject is the file
 *      itself; the edge is a self-edge.
 *
 *   2. **Cargo integration tests** — files under
 *      `<crate-root>/tests/<name>.rs`. Each top-level file there
 *      is its own integration test BINARY that exercises the
 *      crate's library entry point (`<crate-root>/src/lib.rs`)
 *      or, lacking that, the bin entry (`<crate-root>/src/main.rs`).
 *
 * The three per-pattern helpers below ({@link cargoIntegrationCrateRoot},
 * {@link findRustCrateEntryPoint}, {@link rustFileHasInlineTests}) are
 * called directly from the tests-edges hook's F#56 pass. The composed
 * dispatcher {@link findRustTestSubjects} is exported for unit-test
 * convenience and for any future external caller that wants
 * one-call "resolve subjects for a Rust file" semantics; the hook
 * itself bypasses it so the integration-test path can fire
 * unconditionally before the inline-test filename-convention skip.
 */
const RUST_CARGO_INTEGRATION_PATH_RE = /^(.*\/)?tests\/[^/]+\.rs$/;

/**
 * F#56 (2026-05-26): if `filePath` matches Cargo's integration-test
 * layout (`<crate-root>/tests/<name>.rs`), return the crate-root
 * prefix (with trailing slash, or empty for a project-root test).
 * Else null. Pure path arithmetic; no I/O.
 *
 * Nested helper modules under `tests/<bin>/<helper>.rs` intentionally
 * do NOT match — Cargo treats only the immediate child as a separate
 * integration test binary. v1 ships the strict shape; if a project
 * uses nested submodules under a test binary we'll add edges-to-bin
 * resolution in a follow-up.
 */
export function cargoIntegrationCrateRoot(filePath: string): string | null {
  const m = filePath.match(RUST_CARGO_INTEGRATION_PATH_RE);
  return m ? (m[1] ?? '') : null;
}

/**
 * F#56 (2026-05-26): given a Cargo crate-root prefix (possibly empty),
 * return the path to its library or binary entry point as indexed —
 * `<root>src/lib.rs` first, falling back to `<root>src/main.rs`.
 * Returns null when neither is indexed (e.g. a bare `tests/` directory
 * not anchored to a real crate; vendored / unindexed crates).
 */
export function findRustCrateEntryPoint(crateRoot: string, allFiles: ReadonlySet<string>): string | null {
  const lib = crateRoot + 'src/lib.rs';
  if (allFiles.has(lib)) return lib;
  const main = crateRoot + 'src/main.rs';
  if (allFiles.has(main)) return main;
  return null;
}

/**
 * F#56 (2026-05-26): true when `content` carries Rust's inline-test
 * marker — a `#[test]` attribute on any function. The canonical
 * `#[cfg(test)] mod tests { … }` block contains `#[test]` markers
 * on each test function, so the substring match catches both shapes
 * with a single check. Cheap; no AST parsing.
 */
export function rustFileHasInlineTests(content: string): boolean {
  return content.includes('#[test]');
}

/**
 * F#56 (2026-05-26): resolve subjects for a Rust file by Cargo
 * convention. Returns a (possibly empty) list of indexed file paths
 * that this `.rs` file tests:
 *
 *   - Integration: if `testFile` lives at `<crate>/tests/<name>.rs`,
 *     and the crate has a `src/lib.rs` or `src/main.rs` indexed,
 *     return `[entryPoint]`.
 *   - Inline: if `content` carries a `#[test]` marker AND the file
 *     isn't an integration test, return `[testFile]` (self-edge —
 *     the file tests its own production code).
 *   - Else: empty array.
 *
 * Mutually exclusive — an integration-test file isn't also treated
 * as inline. The content parameter is required (the caller passes
 * disk-read source) to keep this fn pure.
 */
export function findRustTestSubjects(testFile: string, content: string, allFiles: ReadonlySet<string>): string[] {
  const crateRoot = cargoIntegrationCrateRoot(testFile);
  if (crateRoot !== null) {
    const entry = findRustCrateEntryPoint(crateRoot, allFiles);
    return entry ? [entry] : [];
  }
  if (rustFileHasInlineTests(content)) {
    return [testFile];
  }
  return [];
}

/** Tiebreak: pick the path whose directory shares the longest leading-segment prefix with `testDir`. */
function pickByLongestPathPrefix(testDir: string, matches: readonly string[]): string {
  const dirParts = testDir.split('/');
  let best = matches[0]!;
  let bestCommon = -1;
  for (const f of matches) {
    const fParts = path.posix.dirname(f).split('/');
    let common = 0;
    for (let i = 0; i < Math.min(dirParts.length, fParts.length); i++) {
      if (dirParts[i] === fParts[i]) common++;
      else break;
    }
    if (common > bestCommon) {
      best = f;
      bestCommon = common;
    }
  }
  return best;
}
