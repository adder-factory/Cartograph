import { getAllFiles } from '../../db/queries-files.js';
import type Cartograph from '../../index.js';
import { globToSafeRegex, isTestPath } from '../../utils.js';
import { MAX_TEST_DESCRIPTIONS_SHOWN } from './render.js';
import { fetchTestDescriptionsForFile } from './test-descriptions.js';

export const DEFAULT_FILES_MODE_DEPTH = 5;
export const MAX_FILES_MODE_DEPTH = 50;

const FILES_MODE_RENDER_CAP = 40;

const BARREL_BASENAMES: ReadonlySet<string> = new Set([
  'index.ts',
  'index.js',
  'index.mjs',
  'index.cjs',
  'index.mts',
  'index.cts',
]);

type FilesModeResult = { ok: true; body: string; footers: string[] } | { ok: false; message: string };

export interface RunTestsForFilesModeArgs {
  files: readonly string[];
  depth: number;
  filter?: string | undefined;
}

function isBarrelFile(filePath: string): boolean {
  const slash = filePath.lastIndexOf('/');
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  return BARREL_BASENAMES.has(base);
}

function buildIsTestPredicate(filterGlob: string | undefined): { predicate: (p: string) => boolean; err?: string } {
  if (!filterGlob) return { predicate: isTestPath };
  const regexBody = globToSafeRegex(filterGlob);
  if (regexBody === null) {
    return {
      predicate: isTestPath,
      err: `Filter glob is not supported (unsafe quantifier or unsupported syntax): \`${filterGlob}\`. Try a simpler pattern like "**/*.test.ts".`,
    };
  }
  const re = new RegExp(regexBody);
  return { predicate: (p: string) => re.test(p) };
}

interface BfsTestImpactArgs {
  cg: Cartograph;
  seedFile: string;
  maxDepth: number;
  isTest: (filePath: string) => boolean;
  affected: Set<string>;
  barrelsReached: Set<string>;
}

function bfsTestImpactFromFile(args: BfsTestImpactArgs): number {
  const { cg, seedFile, maxDepth, isTest, affected, barrelsReached } = args;
  let dependentsVisited = 0;
  const queue: Array<{ file: string; depth: number }> = [{ file: seedFile, depth: 0 }];
  const visited = new Set<string>([seedFile]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    for (const dep of cg.internals.graphManager.getFileDependents(cur.file)) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      dependentsVisited++;
      if (isBarrelFile(dep)) barrelsReached.add(dep);
      if (isTest(dep)) affected.add(dep);
      else queue.push({ file: dep, depth: cur.depth + 1 });
    }
  }
  return dependentsVisited;
}

function formatAffectedTestLines(cg: Cartograph, sorted: readonly string[]): string[] {
  const lines: string[] = [];
  for (const t of sorted) {
    lines.push(`- \`${t}\``);
    const descs = fetchTestDescriptionsForFile(cg, t);
    const shown = descs.slice(0, MAX_TEST_DESCRIPTIONS_SHOWN);
    for (const d of shown) lines.push(`  - L${d.line}: "${d.description}"`);
    if (descs.length > shown.length) {
      lines.push(`  - _…and ${descs.length - shown.length} more assertions_`);
    }
  }
  return lines;
}

function buildFilesModeFooters(args: {
  sorted: readonly string[];
  totalDependents: number;
  inputBarrels: ReadonlySet<string>;
  bfsBarrels: ReadonlySet<string>;
  unmatchedInputs: readonly string[];
}): string[] {
  const { sorted, totalDependents, inputBarrels, bfsBarrels, unmatchedInputs } = args;
  const footers: string[] = [];
  if (unmatchedInputs.length > 0) {
    const unmatchedList = unmatchedInputs.map((f) => `\`${f}\``).join(', ');
    const pathSuffix = unmatchedInputs.length === 1 ? '' : 's';
    const verb = unmatchedInputs.length === 1 ? 'was' : 'were';
    footers.push(
      `> ⚠ ${unmatchedInputs.length} input path${pathSuffix} matched no indexed file and ${verb} skipped: ${unmatchedList}. Check spelling, or \`cartograph_admin({action: 'sync'})\` if the files are new.`,
    );
  }
  if (sorted.length > FILES_MODE_RENDER_CAP) {
    footers.push(
      `_Showing first ${FILES_MODE_RENDER_CAP} of ${sorted.length} — narrow with \`filter\`, or use \`symbol\` mode for symbol-level test discovery._`,
    );
  }
  footers.push(`_Traversed ${totalDependents} dependent file${totalDependents === 1 ? '' : 's'}._`);
  if (inputBarrels.size > 0) {
    const barrelList = [...inputBarrels]
      .sort((a, b) => Number(a > b) - Number(a < b))
      .map((b) => `\`${b}\``)
      .join(', ');
    const isPlural = inputBarrels.size > 1;
    footers.push(
      `> ⚠ Input file${isPlural ? 's are themselves' : ' is itself a'} public-API barrel${isPlural ? 's' : ''} (${barrelList}) — every test that imports the barrel's re-exports is "affected". ` +
        `For an actionable answer pass \`symbol\` instead of \`files\` for symbol-level test discovery.`,
    );
  }
  if (bfsBarrels.size > 0) {
    const barrelList = [...bfsBarrels]
      .sort((a, b) => Number(a > b) - Number(a < b))
      .map((b) => `\`${b}\``)
      .join(', ');
    footers.push(
      `> ⚠ Traversal reached the public-API barrel (${barrelList}) — the blast radius is most of the suite. ` +
        `For an actionable answer pass \`symbol\` instead of \`files\` for symbol-level test discovery.`,
    );
  }
  return footers;
}

export function runTestsForFilesMode(cg: Cartograph, args: RunTestsForFilesModeArgs): FilesModeResult {
  const { predicate: isTest, err } = buildIsTestPredicate(args.filter);
  if (err) return { ok: false, message: err };

  const indexedPaths = new Set(getAllFiles(cg.queries).map((f) => f.path));
  const unmatchedInputs = args.files.filter((f) => !indexedPaths.has(f));
  if (unmatchedInputs.length === args.files.length && args.files.length > 0) {
    const unmatchedList = unmatchedInputs.map((f) => `\`${f}\``).join(', ');
    const fileWordSuffix = args.files.length === 1 ? '' : 's';
    return {
      ok: false,
      message: `None of the ${args.files.length} input file${fileWordSuffix} match indexed paths: ${unmatchedList}. Check spelling, or run \`cartograph_admin({action: 'sync'})\` if the files are new.`,
    };
  }

  const affected = new Set<string>();
  const inputBarrels = new Set<string>();
  const bfsBarrels = new Set<string>();
  let totalDependents = 0;
  for (const f of args.files) {
    if (isBarrelFile(f)) {
      inputBarrels.add(f);
      continue;
    }
    if (isTest(f)) {
      affected.add(f);
      continue;
    }
    totalDependents += bfsTestImpactFromFile({
      cg,
      seedFile: f,
      maxDepth: args.depth,
      isTest,
      affected,
      barrelsReached: bfsBarrels,
    });
  }

  const sorted = [...affected].sort((a, b) => Number(a > b) - Number(a < b));
  const footers = buildFilesModeFooters({ sorted, totalDependents, inputBarrels, bfsBarrels, unmatchedInputs });
  const header = `## Affected test files (${sorted.length})`;
  const bodyLines =
    sorted.length === 0 ? ['- _None._'] : formatAffectedTestLines(cg, sorted.slice(0, FILES_MODE_RENDER_CAP));
  return { ok: true, body: `${header}\n${bodyLines.join('\n')}`, footers };
}
