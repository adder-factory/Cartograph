/**
 * Unit tests for the unified path classifier (`src/path-class.ts`) —
 * the single source of truth that replaced the six divergent
 * path-notion regex sets (`utils.isTestPath` / `isDiagnosticPath`,
 * `shared.isFixturePath`, dead-code `EXEMPT_PATH_PATTERNS`, context's
 * `SCRIPT_PATH_RE`, and `search/query-utils.isTestFile`).
 *
 * Test detection is convention-based and polyglot — the polyglot suite
 * below pins that a Go / Python / Rust / Ruby / JVM test file is
 * recognised, not only a JavaScript one.
 *
 * Also pins the re-export shims: `utils.isTestPath` /
 * `utils.isDiagnosticPath` and `shared.isFixturePath` must keep
 * resolving to the path-class implementations so the existing import
 * sites don't silently drift back apart.
 */
import { describe, it, expect } from 'vitest';
import { pathCategory, isTestPath, isFixturePath, isDiagnosticPath } from '../src/path-class.js';
import { isTestPath as utilsIsTestPath, isDiagnosticPath as utilsIsDiagnosticPath } from '../src/utils.js';
import { isFixturePath as sharedIsFixturePath } from '../src/mcp/tools/shared.js';

describe('pathCategory()', () => {
  it('classifies production code as production', () => {
    expect(pathCategory('src/index.ts')).toBe('production');
    expect(pathCategory('lib/main.ts')).toBe('production');
    expect(pathCategory('src/context/index.ts')).toBe('production');
  });

  it('classifies test files and directories as test', () => {
    expect(pathCategory('src/foo.test.ts')).toBe('test');
    expect(pathCategory('src/foo.spec.tsx')).toBe('test');
    expect(pathCategory('__tests__/foo.ts')).toBe('test');
    expect(pathCategory('src/__mocks__/fs.ts')).toBe('test');
    expect(pathCategory('test/helper.ts')).toBe('test');
    expect(pathCategory('tests/helper.ts')).toBe('test');
    expect(pathCategory('spec/helper.ts')).toBe('test');
    expect(pathCategory('src/integration/api.ts')).toBe('test');
    expect(pathCategory('lib/testing/helpers.go')).toBe('test');
    expect(pathCategory('src/testlib/mocks.rs')).toBe('test');
    // F#21: mock/fixture basenames classify as test even at the top of
    // a production directory (Rust convention: `src/fs/mocks.rs`).
    expect(pathCategory('src/fs/mocks.rs')).toBe('test');
    expect(pathCategory('src/fs/mock.rs')).toBe('test');
    expect(pathCategory('src/fs/fixtures.rs')).toBe('test');
    expect(pathCategory('src/fs/fixture.rs')).toBe('test');
    expect(pathCategory('src/llm/Mocks.ts')).toBe('test');
  });

  it('classifies fixture directories as fixture', () => {
    expect(pathCategory('docs/test-beds/typescript/sample.ts')).toBe('fixture');
    expect(pathCategory('__tests__/fixtures/data.ts')).toBe('fixture');
    expect(pathCategory('src/fixtures/factory.ts')).toBe('fixture');
    expect(pathCategory('lib/test-bed/x.ts')).toBe('fixture');
    expect(pathCategory('src/user.fixture.ts')).toBe('fixture');
  });

  it('lets fixture win over test for a *.test.ts file under a fixture dir', () => {
    // Extraction test-beds carry `*.test.ts`-named files that are
    // fixtures, not runnable tests — fixture precedence handles them.
    expect(pathCategory('docs/test-beds/typescript/sample.test.ts')).toBe('fixture');
    expect(pathCategory('__tests__/fixtures/case.spec.ts')).toBe('fixture');
  });

  it('classifies benchmarks as benchmark', () => {
    expect(pathCategory('bench/run.ts')).toBe('benchmark');
    expect(pathCategory('benchmark/perf.ts')).toBe('benchmark');
    expect(pathCategory('benchmarks/perf.ts')).toBe('benchmark');
    expect(pathCategory('benches/perf.rs')).toBe('benchmark'); // Rust/Cargo
    expect(pathCategory('src/bench/perf.ts')).toBe('benchmark');
  });

  it('classifies generated files as generated', () => {
    expect(pathCategory('src/routeTree.gen.ts')).toBe('generated');
    expect(pathCategory('src/api.generated.ts')).toBe('generated');
    expect(pathCategory('src/general.ts')).toBe('production');
  });

  it('classifies scripts, examples, samples, and demos as script', () => {
    expect(pathCategory('scripts/build.ts')).toBe('script');
    expect(pathCategory('script/build.ts')).toBe('script');
    expect(pathCategory('packages/foo/scripts/run.ts')).toBe('script');
    expect(pathCategory('examples/main.ts')).toBe('script');
    expect(pathCategory('example/main.ts')).toBe('script');
    expect(pathCategory('samples/demo.go')).toBe('script');
    expect(pathCategory('demos/x.ts')).toBe('script');
  });

  it('classifies conventional repo-ROOT build/release scripts as script', () => {
    expect(pathCategory('publish.js')).toBe('script');
    expect(pathCategory('release.mjs')).toBe('script');
    expect(pathCategory('build.ts')).toBe('script');
    expect(pathCategory('deploy.cjs')).toBe('script');
    // Root-anchored: same-named files UNDER a dir are real production code.
    expect(pathCategory('src/build.ts')).toBe('production');
    expect(pathCategory('lib/release.ts')).toBe('production');
  });

  it('matches directory conventions case-insensitively', () => {
    expect(pathCategory('TESTS/foo.ts')).toBe('test');
    expect(pathCategory('src/Spec/thing.rb')).toBe('test');
    expect(pathCategory('src/Examples/demo.go')).toBe('script');
  });

  it('does not match mid-word segment collisions', () => {
    expect(pathCategory('src/processing-scripts.ts')).toBe('production');
    expect(pathCategory('src/script-runner.ts')).toBe('production');
    expect(pathCategory('src/example.ts')).toBe('production');
    expect(pathCategory('src/utils/benchmarking.ts')).toBe('production');
    expect(pathCategory('src/testing-utils.ts')).toBe('production');
  });

  it('treats an empty path as production', () => {
    expect(pathCategory('')).toBe('production');
  });
});

describe('pathCategory() — polyglot test conventions', () => {
  it('recognises non-JavaScript test filename conventions', () => {
    // Suffix `_test.<ext>` — Go, Python, Rust, …
    expect(pathCategory('pkg/handler_test.go')).toBe('test');
    expect(pathCategory('src/parser_test.rs')).toBe('test');
    expect(pathCategory('app/models_test.py')).toBe('test');
    // Suffix `_spec.<ext>` — Ruby (RSpec), Lua (busted), …
    expect(pathCategory('lib/user_spec.rb')).toBe('test');
    expect(pathCategory('src/widget_spec.lua')).toBe('test');
    // Prefix `test_` / `test-` — Python, Ruby, R (testthat), …
    expect(pathCategory('app/test_models.py')).toBe('test');
    expect(pathCategory('tests/testthat/test-utils.R')).toBe('test');
    // CamelCase suffix — JVM, .NET, Swift, Scala, …
    expect(pathCategory('com/example/OrderTest.java')).toBe('test');
    expect(pathCategory('com/example/OrderTests.java')).toBe('test');
    expect(pathCategory('Services/PaymentTests.cs')).toBe('test');
    expect(pathCategory('Sources/AppTests.swift')).toBe('test');
    expect(pathCategory('app/OrderFlowSpec.scala')).toBe('test');
    expect(pathCategory('app/src/OrderHandler.kt')).toBe('production');
    expect(pathCategory('app/src/OrderHandlerTest.kt')).toBe('test');
  });

  it('keeps the CamelCase suffix case-sensitive so lower-case words are safe', () => {
    // A lower-case word merely ending in "test"/"spec" is production.
    expect(pathCategory('src/latest.ts')).toBe('production');
    expect(pathCategory('src/apispec.go')).toBe('production');
    expect(pathCategory('src/manifest.ts')).toBe('production');
  });
});

describe('isTestPath() — test OR fixture', () => {
  it('is true for both test and fixture paths', () => {
    expect(isTestPath('src/foo.test.ts')).toBe(true);
    expect(isTestPath('__tests__/foo.ts')).toBe(true);
    expect(isTestPath('docs/test-beds/ts/x.ts')).toBe(true);
    expect(isTestPath('src/fixtures/factory.ts')).toBe(true);
    expect(isTestPath('pkg/handler_test.go')).toBe(true);
  });

  it('is false for production, script, and benchmark paths', () => {
    expect(isTestPath('src/index.ts')).toBe(false);
    expect(isTestPath('scripts/build.ts')).toBe(false);
    expect(isTestPath('bench/run.ts')).toBe(false);
    expect(isTestPath('')).toBe(false);
  });
});

describe('isFixturePath() — fixture only', () => {
  it('is true for fixture paths and false for plain test paths', () => {
    expect(isFixturePath('docs/test-beds/ts/x.ts')).toBe(true);
    expect(isFixturePath('__tests__/fixtures/data.ts')).toBe(true);
    expect(isFixturePath('src/foo.test.ts')).toBe(false);
    expect(isFixturePath('src/index.ts')).toBe(false);
  });
});

describe('isDiagnosticPath() — any non-production', () => {
  it('is true for test, fixture, script, benchmark, and generated paths', () => {
    expect(isDiagnosticPath('src/foo.test.ts')).toBe(true);
    expect(isDiagnosticPath('docs/test-beds/ts/x.ts')).toBe(true);
    expect(isDiagnosticPath('scripts/build.ts')).toBe(true);
    expect(isDiagnosticPath('bench/run.ts')).toBe(true);
    expect(isDiagnosticPath('examples/main.ts')).toBe(true);
    expect(isDiagnosticPath('pkg/handler_test.go')).toBe(true);
    expect(isDiagnosticPath('src/routeTree.gen.ts')).toBe(true);
  });

  it('is false for production code', () => {
    expect(isDiagnosticPath('src/index.ts')).toBe(false);
    expect(isDiagnosticPath('lib/main.ts')).toBe(false);
    expect(isDiagnosticPath('')).toBe(false);
  });
});

describe('re-export shims stay wired to path-class', () => {
  it('utils.isTestPath / isDiagnosticPath resolve to the unified impl', () => {
    expect(utilsIsTestPath).toBe(isTestPath);
    expect(utilsIsDiagnosticPath).toBe(isDiagnosticPath);
  });

  it('shared.isFixturePath resolves to the unified impl', () => {
    expect(sharedIsFixturePath).toBe(isFixturePath);
  });
});
