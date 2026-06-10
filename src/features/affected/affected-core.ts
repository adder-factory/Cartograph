/**
 * Shared core for the `cartograph affected` CLI and the
 * `cartograph_affected` MCP tool: the indexed-path sets, the test-file
 * decision, and the BFS-through-dependents walk. Both surfaces feed it
 * the same inputs and read back the same {@link AffectedTestsResult};
 * only arg-parsing and presentation differ per surface.
 *
 * Before this module (backlog H3, ex-F4) the CLI carried its own
 * JS-only 6-regex `defaultTestPatterns` and an inline BFS, so it gave
 * wrong answers on Go / Python / Rust / Java repos and drifted from the
 * MCP tool's polyglot `isTestPath` + `is_test` flag + test-name mining.
 */
import type { QueryBuilder } from '../../db/queries.js';
import { getAllFiles } from '../../db/queries-files.js';
import { getFilesWithTestNames } from '../../db/queries-test-names.js';
import { isTestPath } from '../../utils.js';

/** Default BFS depth through the dependents graph. */
export const DEFAULT_DEPTH = 5;

/**
 * Path basenames treated as public-API barrels. A traversal that passes
 * through one of these has, by definition, reached the project's whole
 * public surface — the blast radius is "most of the suite" and a
 * file-level affected-tests answer stops being actionable.
 */
const BARREL_BASENAMES: ReadonlySet<string> = new Set([
  'index.ts',
  'index.js',
  'index.mjs',
  'index.cjs',
  'index.mts',
  'index.cts',
]);

/**
 * True when `filePath` is a public-API barrel — an `index.ts` / `index.js`
 * sitting at a package root. Re-export hubs are always named `index.*`
 * by convention across the languages cartograph indexes, so the basename
 * check alone is the signal. Module-private — only {@link findAffectedTests}
 * consumes it.
 */
function isBarrelFile(filePath: string): boolean {
  const slash = filePath.lastIndexOf('/');
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  return BARREL_BASENAMES.has(base);
}

/** Indexed-path sets needed for test-file detection + input validation. */
export interface IndexedPathSets {
  /**
   * File paths the indexer flagged as `is_test = 1`. The DB flag is the
   * authoritative answer for "is this a test file" — it covers
   * non-conventional test paths (e.g. a `validation/` directory of
   * tests) that the path-pattern fallback would miss.
   */
  isTestByIndex: Set<string>;
  /** Every indexed file path (test + non-test). */
  allIndexedPaths: Set<string>;
  /**
   * File paths the test-name miner extracted ≥1 `it/describe/test(...)`
   * descriptor from. A test-flagged file absent from this set is a
   * harness / fixture / type-only support module with no runnable cases.
   * Empty when the miner hasn't run, in which case the refinement is
   * skipped entirely.
   */
  filesWithTestCases: Set<string>;
}

/**
 * Build the indexed-path sets from the cartograph DB. Cheap — two
 * single SELECTs. Shared so the CLI and MCP surfaces classify test
 * files identically.
 */
export function buildIndexedPathSets(queries: QueryBuilder): IndexedPathSets {
  const isTestByIndex = new Set<string>();
  const allIndexedPaths = new Set<string>();
  for (const f of getAllFiles(queries)) {
    allIndexedPaths.add(f.path);
    if (f.isTest) isTestByIndex.add(f.path);
  }
  return { isTestByIndex, allIndexedPaths, filesWithTestCases: getFilesWithTestNames(queries) };
}

/** Inputs the affected-tests core needs from each surface. */
export interface AffectedCoreInput extends IndexedPathSets {
  /** Resolved, index-known source file paths to find affected tests for. */
  files: string[];
  /** Max BFS depth through dependents. */
  depth: number;
  /**
   * Explicit test-file glob override. When set it is the ONLY signal
   * (caller wants exactly these tests, e.g. "e2e/*.spec.ts").
   */
  customFilter: RegExp | null;
}

/**
 * True when `filePath` should be reported as a test file to re-run.
 *
 * A custom filter, when set, is the explicit override. Otherwise the
 * indexer's `is_test` flag (or the polyglot `isTestPath` fallback for
 * unindexed inputs) is used, refined by the test-name miner: a
 * test-flagged file the miner found no `it/describe` block in (harness
 * / fixture / type-only support module) is NOT a test to re-run.
 */
export function isTestFile(filePath: string, input: AffectedCoreInput): boolean {
  if (input.customFilter) return input.customFilter.test(filePath);
  // isTestPath covers .spec. / .test. / __tests__/ / tests/ / e2e/ /
  // spec/ / .fixture. / *_test.* etc. across every indexed language.
  const flagged = input.isTestByIndex.has(filePath) || isTestPath(filePath);
  if (!flagged) return false;
  // F-r9-3: `is_test` and isTestPath are path-broad — they flag every
  // file under `__tests__/` including harness / fixture / type-only
  // support modules that hold no `it/describe` blocks. When the
  // test-name miner has run (non-empty set) and the file is indexed,
  // require ≥1 mined descriptor. A non-indexed input has no test-case
  // data, so it keeps the path-heuristic verdict.
  if (input.filesWithTestCases.size > 0 && input.allIndexedPaths.has(filePath)) {
    return input.filesWithTestCases.has(filePath);
  }
  return true;
}

/** Result of the affected-tests BFS. */
export interface AffectedTestsResult {
  affectedTests: Set<string>;
  totalDependents: number;
  /**
   * Sorted public-API barrel files the traversal passed through. A
   * non-empty list means the blast radius fanned out across the whole
   * public surface — surfaces a `cartograph_tests_for` hint.
   */
  barrelsReached: string[];
}

/** Minimal graph surface the BFS needs — the file-dependents query. */
export interface FileDependentsSource {
  getFileDependents(filePath: string): string[];
}

/**
 * BFS the `imports`/`references` dependents graph from each input file,
 * collecting the test files reached within `depth` hops. Input files
 * that are themselves tests pass through unchanged.
 */
export function findAffectedTests(graph: FileDependentsSource, input: AffectedCoreInput): AffectedTestsResult {
  const affectedTests = new Set<string>();
  const allDependents = new Set<string>();
  const barrelsReached = new Set<string>();

  for (const file of input.files) {
    if (isTestFile(file, input)) {
      affectedTests.add(file);
      continue;
    }
    collectAffectedDependents({ graph, input, file, out: { affectedTests, allDependents, barrelsReached } });
  }
  return {
    affectedTests,
    totalDependents: allDependents.size,
    barrelsReached: Array.from(barrelsReached).sort((a, b) => Number(a > b) - Number(a < b)),
  };
}

function collectAffectedDependents(args: {
  graph: FileDependentsSource;
  input: AffectedCoreInput;
  file: string;
  out: {
    affectedTests: Set<string>;
    allDependents: Set<string>;
    barrelsReached: Set<string>;
  };
}): void {
  const { graph, input, file, out } = args;
  const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
  const visited = new Set<string>([file]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= input.depth) continue;
    for (const dep of graph.getFileDependents(current.file)) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      recordDependent({ input, dep, nextDepth: current.depth + 1, queue, out });
    }
  }
}

interface RecordDependentArgs {
  input: AffectedCoreInput;
  dep: string;
  nextDepth: number;
  queue: Array<{ file: string; depth: number }>;
  out: {
    affectedTests: Set<string>;
    allDependents: Set<string>;
    barrelsReached: Set<string>;
  };
}

function recordDependent(args: RecordDependentArgs): void {
  const { input, dep, nextDepth, queue, out } = args;
  out.allDependents.add(dep);
  if (isBarrelFile(dep)) out.barrelsReached.add(dep);
  if (isTestFile(dep, input)) out.affectedTests.add(dep);
  else queue.push({ file: dep, depth: nextDepth });
}
