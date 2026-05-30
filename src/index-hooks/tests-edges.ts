/**
 * Tests-edges index hook — adds convention-based `tests` edges from
 * test files to their subject files (e.g. foo.test.ts → foo.ts).
 * Full rebuild on indexAll; incremental rebuild for changed test
 * files on sync.
 *
 * F#56 (2026-05-26): a second emission pass covers Rust's two
 * dominant test conventions that the filename-only convention
 * doesn't reach — inline `#[cfg(test)] mod tests` blocks (self-edge
 * on the production file) and Cargo integration tests at
 * `<crate>/tests/<name>.rs` (edge to the crate's `src/lib.rs` or
 * `src/main.rs`). See {@link emitF56RustTestEdges} below for the
 * dispatch logic, which composes the per-pattern helpers
 * (`cargoIntegrationCrateRoot` / `findRustCrateEntryPoint` /
 * `rustFileHasInlineTests`) from `src/tests-edges/index.ts`.
 */

import * as path from 'path';
import type { IndexHook, IndexHookContext } from './registry.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge } from '../types.js';
import {
  isTestFile,
  findTestSubjects,
  cargoIntegrationCrateRoot,
  findRustCrateEntryPoint,
  rustFileHasInlineTests,
} from '../tests-edges/index.js';
import { logDebug, errMsg } from '../errors.js';
import { insertEdges, deleteEdgesBySourceAndKind, deleteAllEdgesByKind } from '../db/queries-edges.js';
import { getAllFiles } from '../db/queries-files.js';
import { readFileSafe } from '../utils.js';

/**
 * Path patterns that should never be treated as test subjects via the
 * imports-walk fallback. Conservative — we only exclude paths that are
 * unambiguously test/fixture/test-bed code. Excluding `scripts/`,
 * `examples/`, or even `docs/` would mis-fire on monorepos that ship
 * runnable example apps or scripted tooling as production code (e.g.
 * `packages/scripts/` in a tooling repo).
 *
 * If a real prod file under one of these names ends up here, the
 * imports-walk fallback will skip emitting a `tests` edge to it — the
 * convention-based finder remains the primary path; the fallback just
 * loses one edge in this rare case.
 */
const FALLBACK_SUBJECT_EXCLUDED = /(^|\/)(__tests__|__mocks__|tests?|spec|fixtures?|test-beds?)\//;

function isPlausibleSubject(path: string): boolean {
  return !FALLBACK_SUBJECT_EXCLUDED.test(path);
}

/** Extension order tried when an import path lacks one. Ordered to
 *  prefer the same family the test file uses; we resolve generously
 *  since the goal is "is there an indexed file at this resolved path",
 *  not "produce the exact file the bundler picks." */
const IMPORT_RESOLUTION_EXTS: ReadonlyArray<string> = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
];
const IMPORT_RESOLUTION_INDEX_FILES: ReadonlyArray<string> = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  '__init__.py',
  'mod.rs',
];

/**
 * F#46 (2026-05-26): file-extensions tried when resolving a Kotlin /
 * Java / Scala package-path import to an indexed source file. Order
 * preserves intent: `.kt` first because Kotlin's mixed-language
 * monorepos (Spring + Exposed style) put Kotlin atop the dispatch
 * preference; `.java` next for pure-Java imports; `.scala` covers the
 * (rare) Scala test-into-Scala-source case.
 */
const PACKAGE_PATH_EXTS: ReadonlyArray<string> = ['.kt', '.java', '.scala'];

/**
 * F#46 (2026-05-26): Kotlin / Java / Scala package-path import
 * resolver. Resolves an import like
 * `org.jetbrains.exposed.v1.core.Table` to an indexed file whose path
 * ends with `/org/jetbrains/exposed/v1/core/Table.kt` (or .java /
 * .scala). The standard Java/Kotlin convention is that the package
 * path mirrors the source-directory hierarchy under `src/main/` /
 * `src/test/`; if the project follows that convention, the suffix
 * match is unambiguous.
 *
 * Uses a basename index for O(1) candidate-lookup — the import's
 * tail segment (`Table`) keys into the index, then a short list of
 * `Table.kt` / `Table.java` candidates is matched against the full
 * package-path suffix. Without the index, a per-import linear scan
 * over `allFilePaths` would re-walk N file paths per import; on a
 * monorepo with 800 files and 300 test files importing 10 each, that
 * is 2.4M comparisons (~150ms). The index drops the candidate count
 * to typically 1-2.
 *
 * Returns null for: relative paths (handled by
 * {@link resolveRelativeImportToIndexedFile} instead), single-segment
 * imports (no dots — likely a JS bare specifier from a mixed
 * project), and any import where the path-suffix match fails (an
 * external `java.util.UUID` won't have a project file ending in
 * `/java/util/UUID.kt`).
 */
function resolvePackagePathImportToIndexedFile(importPath: string, basenameIdx: Map<string, string[]>): string | null {
  if (importPath.startsWith('.')) return null;
  const lastDot = importPath.lastIndexOf('.');
  if (lastDot < 0) return null;
  const symbol = importPath.substring(lastDot + 1);
  if (!symbol) return null;
  const candidates = basenameIdx.get(symbol);
  if (!candidates) return null;
  const asPath = importPath.replaceAll('.', '/');
  for (const ext of PACKAGE_PATH_EXTS) {
    const suffix = '/' + asPath + ext;
    for (const fp of candidates) {
      if (fp.endsWith(suffix)) return fp;
    }
  }
  return null;
}

/**
 * F#46 (2026-05-26): build a basename → [full paths] index from the
 * indexed file set. One pass over `allFilePaths`; cost is amortised
 * across every test file that probes the imports-walk fallback.
 * Files without an extension are skipped (no useful symbol).
 */
function buildBasenameIndex(allFilePaths: Set<string>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const fp of allFilePaths) {
    const slash = fp.lastIndexOf('/');
    const dot = fp.lastIndexOf('.');
    if (dot < 0 || dot < slash) continue;
    const basename = fp.substring(slash + 1, dot);
    let arr = idx.get(basename);
    if (!arr) {
      arr = [];
      idx.set(basename, arr);
    }
    arr.push(fp);
  }
  return idx;
}

/**
 * Resolve an import-statement string from a test file to a project-
 * relative file path that's actually indexed. Handles only relative
 * imports (`./x`, `../x/y`) — bare specifiers (`vitest`, `@scope/pkg`)
 * are external and not in the project graph. For Kotlin / Java /
 * Scala package-path imports see
 * {@link resolvePackagePathImportToIndexedFile}.
 *
 * Cheap — pure path arithmetic + Set lookups; no I/O. Returns null
 * when the import doesn't resolve to anything indexed.
 */
function resolveRelativeImportToIndexedFile(
  importPath: string,
  fromFile: string,
  allFilePaths: Set<string>,
): string | null {
  if (!importPath.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromFile);
  // Posix-style join handles `..` segments correctly. The `replace` rewinds
  // any accidental `\\` from upstream platform-specific paths.
  const joined = path.posix.normalize(path.posix.join(fromDir, importPath)).replaceAll('\\', '/');
  // 1. Exact match (the import already includes the extension).
  if (allFilePaths.has(joined)) return joined;
  // 2. Try each candidate extension on the bare path.
  for (const ext of IMPORT_RESOLUTION_EXTS) {
    const candidate = joined + ext;
    if (allFilePaths.has(candidate)) return candidate;
  }
  // 3. Try directory-with-index-file (`./util` → `./util/index.ts`).
  for (const indexFile of IMPORT_RESOLUTION_INDEX_FILES) {
    const candidate = path.posix.join(joined, indexFile);
    if (allFilePaths.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Imports-walk fallback. Used when the convention-based finder returns
 * no subject for a test file (e.g. tests named after the bug they
 * cover — `dead-code-pagination.test.ts` testing `src/llm/dead-code.ts`).
 *
 * Walks the test file's `import` nodes (each carries the import-path
 * string in `node.name`), resolves each relative path against the
 * indexed file set, and emits a `tests` edge to each plausibly-prod
 * subject. Cheap — graph read + path arithmetic, no source re-parsing.
 *
 * Caveats:
 * - Only fires when the convention finder returned zero subjects.
 * - Multi-import tests will produce one edge per imported module. That
 *   matches the agent question "what tests cover this file?" — the test
 *   really does exercise each module it imports.
 * - Skips paths under test/fixture/test-bed roots so a
 *   test-of-a-test-helper doesn't edge back to its helper.
 * - Skips bare specifiers (npm packages, builtins) — they aren't in
 *   the project graph.
 */
interface FindTestSubjectsViaImportsArgs {
  ctx: IndexHookContext;
  testFile: string;
  allFilePaths: Set<string>;
  basenameIdx: Map<string, string[]>;
}

function findTestSubjectsViaImports(args: FindTestSubjectsViaImportsArgs): string[] {
  const { ctx, testFile, allFilePaths, basenameIdx } = args;
  const out: string[] = [];
  const seen = new Set<string>();
  const nodesInFile = ctx.queries.getNodesByFile(testFile);
  for (const n of nodesInFile) {
    if (n.kind !== 'import') continue;
    // Try relative first (`./util`); fall through to package-path
    // (`org.jetbrains.exposed.v1.core.Table`). The two resolvers gate
    // each other on the import-string shape, so the call order is
    // safe regardless of which form a given import takes.
    const resolved =
      resolveRelativeImportToIndexedFile(n.name, testFile, allFilePaths) ??
      resolvePackagePathImportToIndexedFile(n.name, basenameIdx);
    if (!resolved) continue;
    if (resolved === testFile) continue;
    if (!isPlausibleSubject(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function insertEdgesFor(ctx: IndexHookContext, testFilePaths: string[], allFilePaths: Set<string>): void {
  const edges: Edge[] = [];
  // F#46 (2026-05-26): build the basename → [paths] index ONCE per
  // hook invocation. Reused by every test file that falls through to
  // the imports-walk fallback. Cost is one pass over allFilePaths;
  // savings is N×M comparisons-per-import on the no-index path.
  const basenameIdx = buildBasenameIndex(allFilePaths);
  for (const tf of testFilePaths) {
    let subjects = findTestSubjects(tf, allFilePaths);
    if (subjects.length === 0) {
      subjects = findTestSubjectsViaImports({ ctx, testFile: tf, allFilePaths, basenameIdx });
    }
    for (const subject of subjects) {
      edges.push({ source: `file:${tf}`, target: `file:${subject}`, kind: 'tests' });
    }
  }
  if (edges.length > 0) insertEdges(ctx.queries, edges);
}

/**
 * F#56 (2026-05-26): emit Rust-specific `tests` edges for the two
 * Cargo-idiomatic patterns the filename-only convention misses.
 *
 * For each `.rs` path in `rustPaths`:
 *   - Integration-test layout (`<crate>/tests/<name>.rs`) → pure
 *     path arithmetic to find the crate's `src/lib.rs` or
 *     `src/main.rs` and emit an edge to it. Skips when neither is
 *     indexed (vendored crates, bare `tests/` outside a crate root).
 *   - Else: read the file once and look for the `#[test]` marker.
 *     If present, emit a self-edge — the file tests its own
 *     production code.
 *
 * Files already classified as tests by the filename convention
 * (`foo_test.rs` / `test_foo.rs`, evaluated by {@link isTestFile})
 * are skipped: they already carry a cross-file edge to their
 * subject, so a self-edge is redundant noise. The rare `foo_test.rs`
 * file with no co-located `foo.rs` is intentionally left without
 * any tests edge (the filename pass already short-circuits to zero
 * subjects; the inline pass deliberately doesn't fall through, to
 * preserve the strict "test files belong with their subject" semantic
 * the filename convention encodes).
 *
 * One disk read per non-integration Rust file in the worst case. On
 * ruff (1,845 Rust files, ~10 KB avg) the I/O budget is ≲ 20 MB
 * total; the substring scan is single-pass.
 *
 * Idempotent under repeated runs — `insertEdges`'s UNIQUE constraint
 * on `(source, target, kind, line, col)` dedupes against any
 * existing same-shape edge.
 */
function emitF56RustTestEdges(
  ctx: IndexHookContext,
  rustPaths: ReadonlyArray<string>,
  allFilePaths: Set<string>,
): void {
  if (rustPaths.length === 0) return;
  const edges: Edge[] = [];
  for (const rp of rustPaths) {
    // Cheap path-arithmetic check first: a file under `<crate>/tests/`
    // is an integration test and ALWAYS gets evaluated, regardless of
    // whether its filename also matches the test-name convention. The
    // canonical example is `crates/ruff/tests/integration_test.rs` —
    // its basename hits `_test.rs` AND it's a cargo integration test;
    // we want the integration edge to `crates/ruff/src/lib.rs`, not a
    // would-be co-located `tests/integration.rs` (which doesn't exist).
    const crateRoot = cargoIntegrationCrateRoot(rp);
    if (crateRoot !== null) {
      const entry = findRustCrateEntryPoint(crateRoot, allFilePaths);
      if (entry) edges.push({ source: `file:${rp}`, target: `file:${entry}`, kind: 'tests' });
      continue;
    }
    // Inline-test path. Skip files the filename convention already
    // classified — `src/foo_test.rs` containing `#[test]` would otherwise
    // get a redundant self-edge alongside the convention's cross-edge.
    // The guard is intentionally narrow: integration tests above bypass
    // this skip even when their basename also matches the convention.
    if (isTestFile(rp)) continue;
    const content = readFileSafe(path.join(ctx.projectRoot, rp));
    if (content === null) continue;
    if (rustFileHasInlineTests(content)) {
      edges.push({ source: `file:${rp}`, target: `file:${rp}`, kind: 'tests' });
    }
  }
  if (edges.length > 0) insertEdges(ctx.queries, edges);
}

function rustPathsIn(files: ReadonlyArray<{ readonly path: string }>): string[] {
  return files.map((f) => f.path).filter((p) => p.endsWith('.rs'));
}

export const HOOK: IndexHook = {
  name: 'tests-edges',
  afterIndexAll(ctx) {
    try {
      const allFiles = getAllFiles(ctx.queries);
      const allFilePaths = new Set(allFiles.map((f) => f.path));
      const testPaths = allFiles.map((f) => f.path).filter(isTestFile);
      deleteAllEdgesByKind(ctx.queries, 'tests');
      insertEdgesFor(ctx, testPaths, allFilePaths);
      // F#56: Rust patterns the filename convention misses. Walks
      // every indexed `.rs` file (cheap path test for integration
      // tests, one content read for inline-test detection).
      emitF56RustTestEdges(ctx, rustPathsIn(allFiles), allFilePaths);
    } catch (err) {
      logDebug(`tests-edges hook (indexAll) failed: ${errMsg(err)}`);
    }
  },
  afterSync(ctx, result: SyncResult) {
    try {
      if (result.changedFilePaths) {
        const stillTracked = new Set(getAllFiles(ctx.queries).map((f) => f.path));
        const changedTests = result.changedFilePaths.filter(isTestFile).filter((p) => stillTracked.has(p));
        // F#56: any changed `.rs` file (test-conventioned or not)
        // may have gained / lost an inline-test marker, or have moved
        // in/out of an integration-test path. Re-evaluate it.
        // (Rename/delete cleanup is handled separately by the FK cascade
        // on the file node — `changedFilePaths` here only covers tracked
        // content changes, not removals.)
        const changedRust = result.changedFilePaths.filter((p) => p.endsWith('.rs')).filter((p) => stillTracked.has(p));
        if (changedTests.length === 0 && changedRust.length === 0) return;
        for (const tf of changedTests) {
          deleteEdgesBySourceAndKind(ctx.queries, `file:${tf}`, 'tests');
        }
        for (const rf of changedRust) {
          // The convention pass above may have already cleared this if
          // `rf` is also in `changedTests`; deleteEdgesBySourceAndKind
          // is idempotent so a second call is safe.
          deleteEdgesBySourceAndKind(ctx.queries, `file:${rf}`, 'tests');
        }
        insertEdgesFor(ctx, changedTests, stillTracked);
        emitF56RustTestEdges(ctx, changedRust, stillTracked);
      } else if (result.filesAdded > 0 || result.filesModified > 0) {
        // No git fast path — full rebuild.
        const allFiles = getAllFiles(ctx.queries);
        const allFilePaths = new Set(allFiles.map((f) => f.path));
        const testPaths = allFiles.map((f) => f.path).filter(isTestFile);
        deleteAllEdgesByKind(ctx.queries, 'tests');
        insertEdgesFor(ctx, testPaths, allFilePaths);
        emitF56RustTestEdges(ctx, rustPathsIn(allFiles), allFilePaths);
      }
    } catch (err) {
      logDebug(`tests-edges hook (sync) failed: ${errMsg(err)}`);
    }
  },
};
