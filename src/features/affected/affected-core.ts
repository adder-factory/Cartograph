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
import { AffectedTestCandidateSchema, type AffectedTestCandidate, type AffectedTestTier } from './contract.js';

const AffectedTestCandidatesSchema = AffectedTestCandidateSchema.array();

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
  /** Ranked, explained test recommendations for agent-facing renderers. */
  candidates: AffectedTestCandidate[];
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
  getFileDependentIndex(): ReadonlyMap<string, readonly string[]>;
}

/**
 * BFS the `imports`/`references` dependents graph from each input file,
 * collecting the test files reached within `depth` hops. Input files
 * that are themselves tests pass through unchanged.
 */
export function findAffectedTests(graph: FileDependentsSource, input: AffectedCoreInput): AffectedTestsResult {
  const candidateByPath = new Map<string, AffectedTestCandidate>();
  const allDependents = new Set<string>();
  const barrelsReached = new Set<string>();
  const dependentIndex = graph.getFileDependentIndex();

  for (const file of input.files) {
    if (isTestFile(file, input)) {
      recordTestCandidate(candidateByPath, {
        path: file,
        tier: 'direct',
        distance: 0,
        reason: 'changed-test',
      });
      continue;
    }
    if (isBarrelFile(file)) {
      barrelsReached.add(file);
      continue;
    }
    collectAffectedDependents({
      dependentIndex,
      input,
      file,
      out: { candidateByPath, allDependents, barrelsReached },
    });
  }
  const candidates = AffectedTestCandidatesSchema.parse([...candidateByPath.values()].sort(compareCandidates));
  return {
    affectedTests: new Set(candidates.map((candidate) => candidate.path)),
    candidates,
    totalDependents: allDependents.size,
    barrelsReached: Array.from(barrelsReached).sort((a, b) => Number(a > b) - Number(a < b)),
  };
}

function collectAffectedDependents(args: {
  dependentIndex: ReadonlyMap<string, readonly string[]>;
  input: AffectedCoreInput;
  file: string;
  out: {
    candidateByPath: Map<string, AffectedTestCandidate>;
    allDependents: Set<string>;
    barrelsReached: Set<string>;
  };
}): void {
  const { dependentIndex, input, file, out } = args;
  const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
  const visited = new Set<string>([file]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= input.depth) continue;
    for (const dep of dependentIndex.get(current.file) ?? []) {
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
    candidateByPath: Map<string, AffectedTestCandidate>;
    allDependents: Set<string>;
    barrelsReached: Set<string>;
  };
}

function recordDependent(args: RecordDependentArgs): void {
  const { input, dep, nextDepth, queue, out } = args;
  out.allDependents.add(dep);
  if (isBarrelFile(dep)) {
    out.barrelsReached.add(dep);
    return;
  }
  if (isTestFile(dep, input)) {
    recordTestCandidate(out.candidateByPath, candidateForDistance(dep, nextDepth));
    return;
  }
  queue.push({ file: dep, depth: nextDepth });
}

function candidateForDistance(path: string, distance: number): AffectedTestCandidate {
  return {
    path,
    tier: affectedTierForDistance(distance),
    distance,
    reason: distance <= 1 ? 'direct-dependent' : 'transitive-dependent',
  };
}

function affectedTierForDistance(distance: number): AffectedTestTier {
  if (distance <= 1) return 'direct';
  if (distance === 2) return 'likely';
  return 'broad';
}

function recordTestCandidate(
  candidateByPath: Map<string, AffectedTestCandidate>,
  candidate: AffectedTestCandidate,
): void {
  const existing = candidateByPath.get(candidate.path);
  if (!existing || candidate.distance < existing.distance) candidateByPath.set(candidate.path, candidate);
}

function compareCandidates(a: AffectedTestCandidate, b: AffectedTestCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.path.localeCompare(b.path);
}
