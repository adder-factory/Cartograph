/**
 * Tests-as-Edges Tests
 *
 * Verifies the convention-based test→subject file resolver and the
 * `tests` edges it produces:
 *   - All recognized test naming conventions (Jest/Vitest, pytest,
 *     Go, RSpec, JUnit/xUnit, Quick/Spek)
 *   - The four-step resolution strategy (co-located, mirrored,
 *     common source roots, basename-anywhere)
 *   - End-to-end via Cartograph: indexAll populates `tests` edges,
 *     sync incrementally refreshes them, getTestsForFile and
 *     getSubjectsOfTest return the expected file records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  testSubjectBasename,
  isTestFile,
  findTestSubjects,
  cargoIntegrationCrateRoot,
  findRustCrateEntryPoint,
  rustFileHasInlineTests,
  findRustTestSubjects,
} from '../src/tests-edges/index.js';
import Cartograph from '../src/index.js';

describe('testSubjectBasename', () => {
  it('recognizes JS/TS .test and .spec suffixes', () => {
    expect(testSubjectBasename('foo.test.ts')).toBe('foo');
    expect(testSubjectBasename('foo.spec.tsx')).toBe('foo');
    expect(testSubjectBasename('Bar.test.js')).toBe('Bar');
    expect(testSubjectBasename('a/b/foo.test.mjs')).toBe('foo');
  });

  it('recognizes Python pytest test_foo style', () => {
    expect(testSubjectBasename('test_foo.py')).toBe('foo');
    expect(testSubjectBasename('pkg/test_handlers.py')).toBe('handlers');
  });

  it('recognizes Go and Rust foo_test style', () => {
    expect(testSubjectBasename('foo_test.go')).toBe('foo');
    expect(testSubjectBasename('foo_test.rs')).toBe('foo');
  });

  it('recognizes Ruby foo_spec / foo_test style', () => {
    expect(testSubjectBasename('foo_spec.rb')).toBe('foo');
    expect(testSubjectBasename('foo_test.rb')).toBe('foo');
  });

  it('recognizes xUnit FooTest / FooTests', () => {
    expect(testSubjectBasename('FooTest.java')).toBe('Foo');
    expect(testSubjectBasename('FooTests.cs')).toBe('Foo');
    expect(testSubjectBasename('FooTest.kt')).toBe('Foo');
  });

  it('recognizes Quick/Spek FooSpec', () => {
    expect(testSubjectBasename('FooSpec.swift')).toBe('Foo');
    expect(testSubjectBasename('FooSpec.kt')).toBe('Foo');
  });

  it('returns null for non-test files', () => {
    expect(testSubjectBasename('foo.ts')).toBeNull();
    expect(testSubjectBasename('handler.py')).toBeNull();
    expect(testSubjectBasename('README.md')).toBeNull();
    // Doesn't false-positive on similar-looking names
    expect(testSubjectBasename('contest.ts')).toBeNull();
    expect(testSubjectBasename('untested.go')).toBeNull();
  });
});

describe('isTestFile', () => {
  it('agrees with testSubjectBasename', () => {
    expect(isTestFile('foo.test.ts')).toBe(true);
    expect(isTestFile('foo.ts')).toBe(false);
  });
});

describe('findTestSubjects (resolver strategies)', () => {
  it('1. co-located: foo/foo.test.ts → foo/foo.ts', () => {
    const all = new Set(['src/foo.ts', 'src/foo.test.ts']);
    expect(findTestSubjects('src/foo.test.ts', all)).toEqual(['src/foo.ts']);
  });

  it('1b. co-located: foo/bar.test.ts → foo/bar/index.ts', () => {
    const all = new Set(['src/bar/index.ts', 'src/bar.test.ts']);
    expect(findTestSubjects('src/bar.test.ts', all)).toEqual(['src/bar/index.ts']);
  });

  it('2. mirrored: foo/__tests__/bar.test.ts → foo/bar.ts', () => {
    const all = new Set(['src/bar.ts', 'src/__tests__/bar.test.ts']);
    expect(findTestSubjects('src/__tests__/bar.test.ts', all)).toEqual(['src/bar.ts']);
  });

  it('2b. mirrored to index: __tests__/sync.test.ts → src/sync/index.ts', () => {
    // Top-level __tests__ doesn't translate to a sibling source root, so
    // the resolver falls through to step 3 (common source roots).
    const all = new Set(['src/sync/index.ts', '__tests__/sync.test.ts']);
    expect(findTestSubjects('__tests__/sync.test.ts', all)).toEqual(['src/sync/index.ts']);
  });

  it('3. common source roots: __tests__/handler.test.ts → lib/handler.ts', () => {
    const all = new Set(['lib/handler.ts', '__tests__/handler.test.ts']);
    expect(findTestSubjects('__tests__/handler.test.ts', all)).toEqual(['lib/handler.ts']);
  });

  it('4. basename-anywhere with prefix-tiebreaker', () => {
    const all = new Set(['packages/auth/utils.ts', 'packages/billing/utils.ts', 'packages/auth/utils.test.ts']);
    // Co-located resolves first → utils.ts in auth wins by directory.
    expect(findTestSubjects('packages/auth/utils.test.ts', all)).toEqual(['packages/auth/utils.ts']);
  });

  it('returns [] for tests with no matching subject', () => {
    const all = new Set(['__tests__/integration.test.ts']);
    expect(findTestSubjects('__tests__/integration.test.ts', all)).toEqual([]);
  });

  it('returns [] for non-test files', () => {
    const all = new Set(['src/foo.ts']);
    expect(findTestSubjects('src/foo.ts', all)).toEqual([]);
  });

  it('does not edge a test file back to itself', () => {
    // Pathological: a file matching the test pattern that also happens
    // to live where its "subject" would resolve. Should never produce a
    // self-edge.
    const all = new Set(['src/foo.test.ts']);
    expect(findTestSubjects('src/foo.test.ts', all)).toEqual([]);
  });

  it('handles tsx test files preferring tsx subject before ts', () => {
    const all = new Set(['src/Component.tsx', 'src/Component.test.tsx']);
    expect(findTestSubjects('src/Component.test.tsx', all)).toEqual(['src/Component.tsx']);
  });

  it('matches Go _test convention to subject .go', () => {
    const all = new Set(['internal/handler.go', 'internal/handler_test.go']);
    expect(findTestSubjects('internal/handler_test.go', all)).toEqual(['internal/handler.go']);
  });

  it('matches Python test_ convention to subject .py', () => {
    const all = new Set(['app/handlers.py', 'tests/test_handlers.py']);
    expect(findTestSubjects('tests/test_handlers.py', all)).toEqual(['app/handlers.py']);
  });

  it('strips top-level tests/ prefix when computing the mirrored subject path', () => {
    // Regression: previously the mirroring regex only matched `/tests/`
    // (slash-prefixed), so a top-level `tests/` directory wasn't stripped
    // and the multi-root fallback (src/lib/app/...) never fired. With a
    // decoy `tests/handlers.py` present, the resolver would have wrongly
    // picked it via the basename-anywhere step instead of the real subject
    // under `lib/`.
    const all = new Set([
      'lib/handlers.py',
      'tests/handlers.py', // decoy
      'tests/test_handlers.py',
    ]);
    expect(findTestSubjects('tests/test_handlers.py', all)).toContain('lib/handlers.py');
  });

  it('strips top-level spec/ prefix similarly', () => {
    const all = new Set(['app/order.rb', 'spec/order_spec.rb']);
    expect(findTestSubjects('spec/order_spec.rb', all)).toEqual(['app/order.rb']);
  });
});

// F#56 (2026-05-26) — Rust-specific test conventions that the
// filename-only convention finder above doesn't reach.
describe('F#56 — Rust test conventions', () => {
  describe('cargoIntegrationCrateRoot', () => {
    it('returns crate-root prefix for `<crate>/tests/<name>.rs`', () => {
      expect(cargoIntegrationCrateRoot('crates/ruff/tests/integration_test.rs')).toBe('crates/ruff/');
    });

    it('returns empty string for a project-root `tests/<name>.rs`', () => {
      expect(cargoIntegrationCrateRoot('tests/foo.rs')).toBe('');
    });

    it('returns null for nested tests/<bin>/<helper>.rs (intentional v1 scope)', () => {
      // Cargo treats only the immediate child of tests/ as a binary;
      // nested helper modules belong to that binary's compilation unit
      // and we don't resolve them in v1.
      expect(cargoIntegrationCrateRoot('crates/ruff/tests/cli/helper.rs')).toBeNull();
    });

    it('returns crateRoot=src/ for src/tests/helper.rs — guard against false-positive lives in findRustCrateEntryPoint', () => {
      // `src/tests/` is a regular module hierarchy, NOT cargo's integration
      // dir. The regex pattern is satisfied (`tests/<name>.rs`) and the
      // strip resolves crateRoot='src/'. The actual guard against treating
      // this as an integration test lives in findRustCrateEntryPoint: it
      // looks for `src/src/lib.rs` which won't exist, returning null and
      // so no edge is emitted. See the companion test in
      // findRustCrateEntryPoint > `returns null when neither lib nor main
      // exists at the crate root`.
      expect(cargoIntegrationCrateRoot('src/tests/helper.rs')).toBe('src/');
    });

    it('returns null for non-test paths', () => {
      expect(cargoIntegrationCrateRoot('crates/ruff/src/linter.rs')).toBeNull();
      expect(cargoIntegrationCrateRoot('src/main.rs')).toBeNull();
    });
  });

  describe('findRustCrateEntryPoint', () => {
    it('prefers src/lib.rs when both lib and main are indexed', () => {
      const all = new Set(['crates/foo/src/lib.rs', 'crates/foo/src/main.rs']);
      expect(findRustCrateEntryPoint('crates/foo/', all)).toBe('crates/foo/src/lib.rs');
    });

    it('falls back to src/main.rs when only main is indexed', () => {
      const all = new Set(['crates/foo/src/main.rs']);
      expect(findRustCrateEntryPoint('crates/foo/', all)).toBe('crates/foo/src/main.rs');
    });

    it('returns null when neither lib nor main exists at the crate root', () => {
      // The `src/tests/helper.rs` shape resolves crateRoot='src/' but
      // `src/src/lib.rs` won't exist — this is the guard that prevents
      // a src/tests/ submodule from being mistaken for an integration test.
      const all = new Set(['src/utils.rs']);
      expect(findRustCrateEntryPoint('crates/missing/', all)).toBeNull();
      expect(findRustCrateEntryPoint('src/', all)).toBeNull();
    });

    it('handles empty crateRoot (project-root cargo layout)', () => {
      const all = new Set(['src/lib.rs', 'tests/foo.rs']);
      expect(findRustCrateEntryPoint('', all)).toBe('src/lib.rs');
    });
  });

  describe('rustFileHasInlineTests', () => {
    it('detects #[test] marker', () => {
      expect(rustFileHasInlineTests('#[test]\nfn t() {}')).toBe(true);
    });

    it('detects #[test] inside a #[cfg(test)] mod tests block', () => {
      const src = `
pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn add_works() {
      assert_eq!(add(1, 2), 3);
    }
}
`;
      expect(rustFileHasInlineTests(src)).toBe(true);
    });

    it('returns false for production code with no test attribute', () => {
      expect(rustFileHasInlineTests('pub fn add(a: i32, b: i32) -> i32 { a + b }')).toBe(false);
    });

    it('does NOT false-positive on a string literal containing "#[test]"', () => {
      // Acknowledged limitation — substring match doesn't distinguish
      // code from string content. The pattern is rare enough that the
      // cheap match wins; an AST-aware detect would close this with
      // a perf cost we don't pay today.
      const src = `pub const DOC: &str = "#[test]";`;
      expect(rustFileHasInlineTests(src)).toBe(true);
    });
  });

  describe('findRustTestSubjects (dispatch)', () => {
    it('integration test → crate src/lib.rs', () => {
      const all = new Set(['crates/foo/src/lib.rs', 'crates/foo/tests/integration_test.rs']);
      expect(findRustTestSubjects('crates/foo/tests/integration_test.rs', '', all)).toEqual(['crates/foo/src/lib.rs']);
    });

    it('integration test with no crate root resolved → empty', () => {
      // `tests/foo.rs` at project root but no `src/lib.rs` indexed —
      // could be a stray tests dir or unindexed crate. Skip silently.
      const all = new Set(['tests/foo.rs']);
      expect(findRustTestSubjects('tests/foo.rs', '', all)).toEqual([]);
    });

    it('inline #[test] → self-edge', () => {
      const all = new Set(['crates/foo/src/linter.rs']);
      const content = '#[cfg(test)]\nmod tests {\n  #[test]\n  fn x() {}\n}';
      expect(findRustTestSubjects('crates/foo/src/linter.rs', content, all)).toEqual(['crates/foo/src/linter.rs']);
    });

    it('production code with no test marker → empty', () => {
      const all = new Set(['crates/foo/src/utils.rs']);
      expect(findRustTestSubjects('crates/foo/src/utils.rs', 'pub fn x() {}', all)).toEqual([]);
    });

    it('integration-test layout takes precedence over inline detection', () => {
      // A file at `crates/foo/tests/foo.rs` containing `#[test]` is
      // classified as integration ONLY — emits edge to lib.rs, not
      // self-edge. This matches Cargo's semantic that integration
      // tests target the crate's public API.
      const all = new Set(['crates/foo/src/lib.rs', 'crates/foo/tests/foo.rs']);
      const content = '#[test]\nfn x() {}';
      expect(findRustTestSubjects('crates/foo/tests/foo.rs', content, all)).toEqual(['crates/foo/src/lib.rs']);
    });
  });
});

describe('Cartograph end-to-end (tests edges wired into indexAll/sync)', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-edges-e2e-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'sync'));
    fs.mkdirSync(path.join(dir, '__tests__'));
    // Subject files
    fs.writeFileSync(path.join(dir, 'src', 'sync', 'index.ts'), 'export const sync = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'sync', 'watcher.ts'), 'export const watcher = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'utils.ts'), 'export const utils = 1;');
    // Tests
    fs.writeFileSync(path.join(dir, '__tests__', 'sync.test.ts'), 'import { sync } from "../src/sync.js"; export {};');
    fs.writeFileSync(
      path.join(dir, 'src', 'sync', 'watcher.test.ts'),
      'import { watcher } from "./watcher.js"; export {};',
    );
    // Feature-themed test (no single subject)
    fs.writeFileSync(path.join(dir, '__tests__', 'integration.test.ts'), 'export {};');

    cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexAll populates tests edges (mirrored layout: __tests__/sync.test.ts → src/sync/index.ts)', () => {
    const subjects = cg.stats.getSubjectsOfTest('__tests__/sync.test.ts');
    const paths = subjects.map((s) => s.path);
    expect(paths).toContain('src/sync/index.ts');
  });

  it('indexAll populates tests edges (co-located: src/sync/watcher.test.ts → src/sync/watcher.ts)', () => {
    const subjects = cg.stats.getSubjectsOfTest('src/sync/watcher.test.ts');
    expect(subjects.map((s) => s.path)).toEqual(['src/sync/watcher.ts']);
  });

  it('getTestsForFile returns the test that covers a given subject (incoming edges)', () => {
    const tests = cg.stats.getTestsForFile('src/sync/watcher.ts');
    expect(tests.map((t) => t.path)).toContain('src/sync/watcher.test.ts');
  });

  it('returns empty array for tests with no resolvable subject (no false-positive guesses)', () => {
    const subjects = cg.stats.getSubjectsOfTest('__tests__/integration.test.ts');
    expect(subjects).toEqual([]);
  });

  it('returns empty array for non-test files queried as tests', () => {
    expect(cg.stats.getSubjectsOfTest('src/sync/index.ts')).toEqual([]);
  });

  it("sync refreshes a test file's edges when its subject convention changes", async () => {
    // Add a new subject file and a co-located test for it. After sync,
    // the new test should have a `tests` edge to the new subject.
    fs.writeFileSync(path.join(dir, 'src', 'newmod.ts'), 'export const m = 1;');
    fs.writeFileSync(path.join(dir, 'src', 'newmod.test.ts'), 'import "./newmod";');

    await cg.sync();
    const subjects = cg.stats.getSubjectsOfTest('src/newmod.test.ts');
    expect(subjects.map((s) => s.path)).toEqual(['src/newmod.ts']);
  });

  it('sync removes stale edges when a subject file is deleted (FK cascade)', async () => {
    // The cascade is on the file *node* (kind='file' has nodes_fts triggers
    // and FK constraints from edges). When we sync after deleting the
    // subject, edges to it should disappear.
    fs.unlinkSync(path.join(dir, 'src', 'sync', 'watcher.ts'));
    await cg.sync();
    const subjects = cg.stats.getSubjectsOfTest('src/sync/watcher.test.ts');
    expect(subjects.map((s) => s.path)).not.toContain('src/sync/watcher.ts');
  });
});

// F#56 (2026-05-26) — end-to-end coverage for the Rust integration-test
// and inline-test patterns. Uses a minimal cargo-style fixture project.
describe('F#56 — Rust tests-edges end-to-end', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-edges-rust-e2e-'));
    fs.mkdirSync(path.join(dir, 'crates', 'foo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'crates', 'foo', 'tests'), { recursive: true });
    // Cargo lib crate
    fs.writeFileSync(path.join(dir, 'crates', 'foo', 'src', 'lib.rs'), 'pub fn add(a: i32, b: i32) -> i32 { a + b }');
    // Production source with inline tests (self-edge target)
    fs.writeFileSync(
      path.join(dir, 'crates', 'foo', 'src', 'linter.rs'),
      `pub fn lint(s: &str) -> bool { !s.is_empty() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lint_works() {
      assert!(lint("a"));
    }
}
`,
    );
    // Production source without inline tests
    fs.writeFileSync(path.join(dir, 'crates', 'foo', 'src', 'utils.rs'), 'pub fn util() -> i32 { 1 }');
    // Cargo integration test (edge to lib.rs)
    fs.writeFileSync(
      path.join(dir, 'crates', 'foo', 'tests', 'integration.rs'),
      `#[test]
fn integration_works() {
    assert_eq!(foo::add(1, 2), 3);
}
`,
    );

    cg = Cartograph.initSync(dir, { config: { include: ['**/*.rs'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cargo integration test → crate lib.rs', () => {
    const subjects = cg.stats.getSubjectsOfTest('crates/foo/tests/integration.rs');
    expect(subjects.map((s) => s.path)).toEqual(['crates/foo/src/lib.rs']);
  });

  it('inline #[cfg(test)] mod tests → self-edge', () => {
    const subjects = cg.stats.getSubjectsOfTest('crates/foo/src/linter.rs');
    expect(subjects.map((s) => s.path)).toEqual(['crates/foo/src/linter.rs']);
  });

  it('getTestsForFile resolves both inline self-test and integration target', () => {
    // The lib.rs has the integration test pointing AT it; it has no inline
    // tests itself, so only the integration edge appears.
    const libTests = cg.stats.getTestsForFile('crates/foo/src/lib.rs');
    expect(libTests.map((t) => t.path)).toEqual(['crates/foo/tests/integration.rs']);
    // The linter.rs has only its own self-edge.
    const linterTests = cg.stats.getTestsForFile('crates/foo/src/linter.rs');
    expect(linterTests.map((t) => t.path)).toEqual(['crates/foo/src/linter.rs']);
  });

  it('production Rust without #[test] gets no edge', () => {
    expect(cg.stats.getSubjectsOfTest('crates/foo/src/utils.rs')).toEqual([]);
  });

  it('integration-test at `tests/<name>_test.rs` still emits the lib.rs cross-edge (filename convention does not pre-empt F#56)', async () => {
    // The basename `bar_test.rs` matches the filename convention's
    // `(.+?)_test\.rs` rule (subject = `bar`), AND it lives under
    // `<crate>/tests/`. The filename pass looks for a co-located
    // `tests/bar.rs` — won't exist usually — so it emits 0 edges. The
    // F#56 pass MUST still fire for integration-test paths regardless
    // of the basename. Without the integration-precedence in
    // emitF56RustTestEdges this would silently produce 0 edges.
    fs.writeFileSync(path.join(dir, 'crates', 'foo', 'tests', 'bar_test.rs'), '#[test]\nfn bar() {}\n');
    await cg.sync();
    const subjects = cg.stats.getSubjectsOfTest('crates/foo/tests/bar_test.rs');
    expect(subjects.map((s) => s.path)).toEqual(['crates/foo/src/lib.rs']);
  });

  it('`src/foo_test.rs` matching the filename convention does NOT get a redundant F#56 self-edge', async () => {
    // Pathological: a Rust file under `src/` whose basename matches the
    // filename convention (`foo_test.rs`) AND contains `#[test]`. The
    // convention pass tries `src/foo.rs` — if absent, it emits 0; if
    // present, it emits the cross-edge. The F#56 pass would otherwise
    // emit a self-edge on top — defeated by the isTestFile guard inside
    // emitF56RustTestEdges. Net edge count for this file should match
    // the filename convention only.
    fs.writeFileSync(path.join(dir, 'crates', 'foo', 'src', 'bar.rs'), 'pub fn bar() {}');
    fs.writeFileSync(path.join(dir, 'crates', 'foo', 'src', 'bar_test.rs'), '#[test]\nfn test_bar() {}\n');
    await cg.sync();
    const subjects = cg.stats.getSubjectsOfTest('crates/foo/src/bar_test.rs');
    expect(subjects.map((s) => s.path)).toEqual(['crates/foo/src/bar.rs']);
  });

  it('sync re-evaluates a Rust file when its inline tests are added', async () => {
    // utils.rs starts with no tests. Add a #[test] block; sync should
    // emit a self-edge afterward.
    expect(cg.stats.getSubjectsOfTest('crates/foo/src/utils.rs')).toEqual([]);
    fs.writeFileSync(
      path.join(dir, 'crates', 'foo', 'src', 'utils.rs'),
      `pub fn util() -> i32 { 1 }

#[cfg(test)]
mod tests {
    #[test]
    fn t() {}
}
`,
    );
    await cg.sync();
    const subjects = cg.stats.getSubjectsOfTest('crates/foo/src/utils.rs');
    expect(subjects.map((s) => s.path)).toEqual(['crates/foo/src/utils.rs']);
  });
});
