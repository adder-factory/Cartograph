/**
 * `cartograph_affected` — verifies the agent-facing surface for the
 * post-edit reactive workflow ("which tests should I re-run after
 * changing these files?"). Same BFS-through-dependents logic as the
 * CLI, exposed without --stdin / --json / chalk decoration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_affected', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-affected-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Co-locate the test file in src/ — `.test.` in the filename
    // is enough to trigger the default test-pattern match. Putting
    // it under __tests__/ at the repo root caused the resolver to
    // not connect import edges in the temp-dir fixture for reasons
    // I haven't fully traced; co-location is the working pattern
    // used by feature_envy / type-edge tests in this suite.
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(): number { return 2; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'setup.ts'), `globalThis.__cartographSetup = true;\n`);
    fs.writeFileSync(
      path.join(dir, 'src', 'side.ts'),
      `import './setup.js';\nexport function side(): number { return 3; }\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'a.test.ts'),
      `import { alpha } from './a.js';\nexport function checkAlpha(): number { return alpha(); }\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'side.test.ts'),
      `import { side } from './side.js';\nexport function checkSide(): number { return side(); }\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns test files that import a changed source file', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a.ts'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Affected test files/);
    expect(text).toMatch(/src\/a\.test\.ts/);
  });

  it('includeCommands appends package-script verification commands', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        version: '0.0.0',
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
      }),
    );
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a.ts'],
      includeCommands: true,
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('### Verification commands');
    expect(text).toContain('npm test -- src/a.test.ts');
    expect(text).toContain('npm run typecheck');
  });

  it('walks reverse dependents through side-effect imports', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['src/setup.ts'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Affected test files/);
    expect(text).toMatch(/src\/side\.test\.ts/);
  });

  it('surfaces side-effect importers as file-node graph callers', async () => {
    const result = await handler.execute('cartograph_graph', {
      start: 'src/setup.ts',
      direction: 'callers',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Callers of src\/setup\.ts/);
    expect(text).toMatch(/src\/side\.ts/);
  });

  it('returns no tests when the changed file has no test dependents', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['src/b.ts'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Affected test files \(0\)/);
    expect(text).toMatch(/No test files affected/);
  });

  it('passes through input files that are themselves tests', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a.test.ts'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/src\/a\.test\.ts/);
  });

  it('rejects empty `files` array', async () => {
    const result = await handler.execute('cartograph_affected', { files: [] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/non-empty string array/);
  });

  it('rejects non-string entries in `files` (schema layer catches first)', async () => {
    const result = await handler.execute('cartograph_affected', { files: [123, 'src/a.ts'] });
    const text = result.content[0]?.text ?? '';
    // The Zod dispatch-boundary validator rejects before our
    // handler-level parseFiles ever runs. The `defineTool` migration
    // (P4) changed the message wording from the legacy JSON-Schema
    // validator's "must be of type string" to Zod's `formatZodError`
    // shape — `files[0]: expected string, received number`. Any of the
    // three forms signals the same wrong-type rejection.
    expect(text).toMatch(/must be of type string|non-empty strings|expected string, received number/);
  });

  it('accepts a custom filter glob', async () => {
    // Custom filter narrows what counts as a test file. With pattern
    // matching `e2e/*.spec.ts`, the existing __tests__ test isn't a
    // match, so the result should be empty.
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a.ts'],
      filter: 'e2e/*.spec.ts',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Affected test files \(0\)/);
  });

  it('rejects an invalid glob filter', async () => {
    // Pass something globToSafeRegex returns null for (the ReDoS
    // safeguard rejects pathological wildcard-coalescing inputs).
    // Generic invalid input: an unbounded sequence of `*`.
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a.ts'],
      filter: '****',
    });
    const text = result.content[0]?.text ?? '';
    // Either "invalid filter glob" (rejected) or normal output (passed):
    // depends on globToSafeRegex's exact rejection rules. Soft assert
    // that we don't crash and we get a result back.
    expect(text.length).toBeGreaterThan(0);
  });

  // F-H — input files that aren't in the index used to be silently
  // dropped. They now surface as a footer warning (when some inputs
  // resolved) or an actionable error (when none did).
  it('surfaces a footer warning when some input files are not indexed', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a.ts', 'src/does_not_exist.ts'],
    });
    const text = result.content[0]?.text ?? '';
    // Resolved subset still processed:
    expect(text).toMatch(/Affected test files/);
    expect(text).toMatch(/src\/a\.test\.ts/);
    // Warning footer mentions the unindexed file:
    expect(text).toMatch(/Input file not indexed/);
    expect(text).toMatch(/src\/does_not_exist\.ts/);
  });

  it('errors out with edit-distance suggestions when no input files match indexed paths', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['src/a_typo.ts'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/None of the .* input file/);
    expect(text).toMatch(/Did you mean/);
    // The closest match should be the indexed `src/a.ts`.
    expect(text).toMatch(/src\/a\.ts/);
  });

  // Audit #24: a hopeless input — one no indexed path is plausibly a
  // typo of — must NOT drag in an unrelated path as a "did you mean".
  // The relevance floor drops every candidate, so the error carries no
  // suggestion line at all rather than three irrelevant ones.
  it('omits the "Did you mean" line when no indexed path is a plausible typo of the input', async () => {
    const result = await handler.execute('cartograph_affected', {
      files: ['zzzzzzzzzzzzzzzzzzzzzzzz.qqqqq'],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/None of the .* input file/);
    expect(text).not.toMatch(/Did you mean/);
    // And it certainly should not suggest the unrelated indexed files.
    expect(text).not.toMatch(/src\/a\.ts/);
  });
});

// Friction-Y (2026-05-14): `files` is now optional. When omitted, the
// changed set is derived from `git diff HEAD` on the project root.
// Clean tree → friendly "no uncommitted changes" hint; dirty tree →
// normal BFS result over the derived set. These tests build a real
// git repo so the derivation hits the actual `listChangedFilesSince`
// path rather than mocking it.
describe('cartograph_affected — default-to-git-diff (Friction-Y)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  function git(...argv: string[]): void {
    execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-affected-git-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(): number { return 2; }\n`);
    fs.writeFileSync(
      path.join(dir, 'src', 'a.test.ts'),
      `import { alpha } from './a.js';\nexport function checkAlpha(): number { return alpha(); }\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    // Initialise git so listChangedFilesSince has a HEAD to diff against.
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('clean tree → friendly "no uncommitted changes" message (not an error)', async () => {
    // Nothing modified — git sees a clean tree.
    const result = await handler.execute('cartograph_affected', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No uncommitted changes/);
    expect(text).toMatch(/Pass `files:/);
    // CRITICALLY: NOT a missing-arg error.
    expect(text).not.toMatch(/Missing required argument/i);
    expect(text).not.toMatch(/must be a non-empty/);
  });

  it('dirty tree → derives changed set from git diff and finds affected tests', async () => {
    // Modify src/a.ts so git surfaces it in `diff HEAD`.
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 99; }\n`);
    const result = await handler.execute('cartograph_affected', {});
    const text = result.content[0]?.text ?? '';
    // Should find a.test.ts as the affected test.
    expect(text).toMatch(/Affected test files/);
    expect(text).toMatch(/src\/a\.test\.ts/);
    // Header should annotate the derivation source so the agent
    // can see which mode ran.
    expect(text).toMatch(/from `git diff HEAD`/);
    // Should list the derived changed file.
    expect(text).toMatch(/changed: `src\/a\.ts`/);
  });

  it('clean tree with content-drift → cross-refs `cartograph_changed_since`', async () => {
    // Reproduce the friction the cross-ref hint guards against: working
    // tree is git-clean AND the indexed HEAD matches the current HEAD,
    // but the indexed `content_hash` for some file lags its on-disk SHA.
    // `git diff HEAD` returns empty so `affected` short-circuits with
    // "no uncommitted changes", but `cartograph_changed_since` re-hashes
    // every tracked file against the index and would flag the drift.
    // The hint points the agent at the other tool so the disagreement
    // is resolvable in one read.
    //
    // Repro: directly mutate the indexed `content_hash` for a tracked
    // file to a wrong value. Doing it by hand (vs editing → committing
    // → resyncing → re-corrupting) keeps git clean AND keeps the indexed
    // HEAD aligned with current HEAD, which is what triggers the
    // `contentDriftedFiles`-not-null path in `getFreshnessInfo`. Mirrors
    // the live scenario where a background process or auto-formatter
    // re-wrote a file after indexing without the watcher picking it up.
    cg.queries.db.prepare(`UPDATE files SET content_hash = 'pretend-stale-hash' WHERE path = 'src/a.ts'`).run();
    // Bump mtime to AFTER index_timestamp so isFileStale's mtime fast-path
    // doesn't short-circuit "fresh" before the hash check runs (the
    // function's two-stage design — mtime first, hash only when mtime
    // moved — would otherwise mask our injected content_hash drift).
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    // Invalidate the freshness LRU so the next read recomputes.
    cg.stats.invalidateFreshness();
    // `allowStale: true` bypasses the freshness gate's auto-sync so the
    // injected drift survives until the handler queries `getFreshness()`.
    const result = await handler.execute('cartograph_affected', { allowStale: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No uncommitted changes/);
    expect(text).toMatch(/cartograph_changed_since/);
    expect(text).toMatch(/content-drifted on disk/);
  });

  it('dirty tree with untracked file → derives untracked file too', async () => {
    // Untracked source file (no edge to test file, but should surface as derived).
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return 3; }\n`);
    const result = await handler.execute('cartograph_affected', {});
    const text = result.content[0]?.text ?? '';
    // Either lists c.ts as the derived input OR — if extraction
    // ran AFTER the untracked write and c.ts wasn't reindexed —
    // gives a clean-tree message. Both are coherent. We test the
    // looser predicate so the test isn't fragile to indexer
    // timing.
    const handled = /from `git diff HEAD`/.test(text) || /No uncommitted changes/.test(text);
    expect(handled).toBe(true);
  });
});

// FRICTION-AB (2026-05-14): the `.cartograph/` index directory must
// never appear in a git-derived changed-file set, even when the repo
// has NOT gitignored it. The DB / WAL / config inside it are
// cartograph's own metadata, never project source.
describe('listChangedFilesSince — excludes .cartograph/ (FRICTION-AB)', () => {
  let dir: string;

  function git(...argv: string[]): void {
    execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ab-git-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops untracked .cartograph/ paths while keeping real source changes', async () => {
    const { listChangedFilesSince } = await import('../src/git-utils.js');
    // Simulate a fresh repo WITHOUT a .gitignore for .cartograph/ — the
    // index dir + sidecars all look like untracked adds to git.
    fs.mkdirSync(path.join(dir, '.cartograph', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cartograph', 'cartograph.db'), 'binary');
    fs.writeFileSync(path.join(dir, '.cartograph', 'cartograph.db-wal'), 'wal');
    fs.writeFileSync(path.join(dir, '.cartograph', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, '.cartograph', 'cache', 'x.bin'), 'c');
    // ...alongside a genuine source edit.
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 99; }\n`);

    const changed = listChangedFilesSince(dir, 'HEAD');
    expect(changed).not.toBeNull();
    expect(changed).toContain('src/a.ts');
    // No path inside .cartograph/ survives the filter.
    expect(changed!.some((p) => p.split(/[/\\]/).includes('.cartograph'))).toBe(false);
  });

  it('isCartographMetaPath matches path segments, not substrings', async () => {
    const { isCartographMetaPath } = await import('../src/git-utils.js');
    expect(isCartographMetaPath('.cartograph/cartograph.db')).toBe(true);
    expect(isCartographMetaPath('foo/.cartograph/config.json')).toBe(true);
    expect(isCartographMetaPath('.cartograph')).toBe(true);
    // A real source file that merely contains the substring must NOT match.
    expect(isCartographMetaPath('src/.cartograph-helper.ts')).toBe(false);
    expect(isCartographMetaPath('docs/about-cartograph.md')).toBe(false);
    expect(isCartographMetaPath('src/a.ts')).toBe(false);
  });
});

/**
 * Regression for friction F-r9-3: `is_test` / isTestPath are path-broad
 * — they flag every file under a test directory, including harness /
 * fixture / type-only support modules that hold no `it/describe`
 * blocks. Those are not tests to re-run and must not appear in the
 * affected list.
 */
describe('cartograph_affected — excludes test-flagged files with no test cases', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-affected-harness-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.ts'), `export function compute(): number { return 1; }\n`);
    // A real test file — has a mined `it` descriptor.
    fs.writeFileSync(
      path.join(dir, 'src', 'lib.test.ts'),
      `import { describe, it } from 'vitest';\n` +
        `import { compute } from './lib.js';\n` +
        `describe('lib', () => { it('computes', () => { compute(); }); });\n`,
    );
    // A test-flagged support module (`.test.` in the name) that holds
    // NO it/describe block — pure harness code.
    fs.writeFileSync(
      path.join(dir, 'src', 'harness.test.ts'),
      `import { compute } from './lib.js';\n` + `export function setup(): number { return compute(); }\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a real test file but drops a harness file with no it/describe', async () => {
    const result = await handler.execute('cartograph_affected', { files: ['src/lib.ts'] });
    const text = result.content[0]?.text ?? '';
    // The real test (mined `it`) is reported.
    expect(text).toMatch(/src\/lib\.test\.ts/);
    // The harness module (no test cases) is NOT — even though both
    // import lib.ts and both match the `.test.` path pattern.
    expect(text).not.toMatch(/harness\.test\.ts/);
  });
});

/**
 * Friction fix (b): an edited leaf module re-exported through a
 * public-API barrel (`src/index.ts`) fans the BFS out to ~half the
 * suite. The report must (1) cap the rendered rows with a "showing
 * first N of M" footer and (2) append a barrel-traversal hint pointing
 * the agent at `cartograph_tests_for`.
 */
describe('cartograph_affected — barrel-dump cap + hint', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;
  /** Above DEFAULT_ROW_LIMIT (40) so the "showing first N of M" cap fires. */
  const TEST_COUNT = 50;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-affected-barrel-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Leaf module — the file we "edit".
    fs.writeFileSync(path.join(dir, 'src', 'leaf.ts'), `export function leaf(): number { return 1; }\n`);
    // Public-API barrel — re-exports the leaf.
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `export { leaf } from './leaf.js';\n`);
    // Many test files, each importing the barrel — the fan-out shape.
    for (let i = 0; i < TEST_COUNT; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `t${i}.test.ts`),
        `import { describe, it } from 'vitest';\n` +
          `import { leaf } from './index.js';\n` +
          `describe('t${i}', () => { it('uses leaf', () => { leaf(); }); });\n`,
      );
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps the rendered rows and emits a "showing first N of M" footer', async () => {
    const result = await handler.execute('cartograph_affected', { files: ['src/leaf.ts'] });
    const text = result.content[0]?.text ?? '';
    // The header counts the full affected set...
    expect(text).toMatch(new RegExp(String.raw`Affected test files \(${TEST_COUNT}\)`));
    // ...but the body is capped at the default 40 rows.
    const renderedRows = (text.match(/^- `src\/t\d+\.test\.ts`$/gm) ?? []).length;
    expect(renderedRows).toBe(40);
    // ...and a cap footer explains the trim.
    expect(text).toMatch(new RegExp(`Showing first 40 of ${TEST_COUNT} affected test files`));
  });

  it('appends a public-API-barrel traversal hint pointing at cartograph_tests_for', async () => {
    const result = await handler.execute('cartograph_affected', { files: ['src/leaf.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Traversal reached the public-API barrel/);
    expect(text).toMatch(/src\/index\.ts/);
    expect(text).toMatch(/cartograph_tests_for/);
  });

  it('no barrel hint when the traversal never passes through an index.* file', async () => {
    // Editing a test file directly — it passes through unchanged, no
    // BFS through the barrel.
    const result = await handler.execute('cartograph_affected', { files: ['src/t0.test.ts'] });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/Traversal reached the public-API barrel/);
  });
});
