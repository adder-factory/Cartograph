import type Cartograph from '../../index.js';
import { compareToRef, type CompareResult } from '../../compare/index.js';
import { listChangedFilesSince } from '../../git-utils.js';
import { type AffectedTestCandidate, buildIndexedPathSets, findAffectedTests } from '../affected/index.js';
import {
  type PackageManager,
  detectPackageManager,
  packageScriptCommand,
  readPackageScripts,
  shellQuote,
} from '../../package-scripts.js';
import {
  VerificationPlanSchema,
  type VerificationCommand,
  type VerificationPlan,
  type VerificationStructuralSummary,
} from './contract.js';

export interface VerificationPlanOptions {
  files?: readonly string[];
  ref?: string;
  depth?: number;
}

export interface BuildVerificationCommandsArgs {
  manager: PackageManager;
  scripts: Readonly<Record<string, string>>;
  candidates: readonly AffectedTestCandidate[];
  suiteRisk: boolean;
}

const TARGETED_TEST_LIMIT = 20;
const DEFAULT_VERIFY_DEPTH = 5;

export function buildVerificationCommands(args: BuildVerificationCommandsArgs): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  const targetedTests = args.candidates
    .filter((candidate) => candidate.tier !== 'broad')
    .slice(0, TARGETED_TEST_LIMIT)
    .map((candidate) => candidate.path);
  if (targetedTests.length > 0) {
    const command = targetedTestCommand(args.manager, args.scripts, targetedTests);
    if (command) {
      commands.push({
        kind: 'targeted-tests',
        command,
        reason: 'Run the direct and likely tests selected from the dependency graph.',
      });
    }
  }

  const hasBroadCandidates = args.candidates.some((candidate) => candidate.tier === 'broad');
  const needsFullSuite = args.suiteRisk || hasBroadCandidates || args.candidates.length === 0;
  if (needsFullSuite && args.scripts['test']) {
    commands.push({
      kind: 'full-suite',
      command: packageScriptCommand(args.manager, 'test'),
      reason:
        args.candidates.length === 0
          ? 'No graph-selected test covered the changed files; use the full suite as the safe fallback.'
          : 'Broad dependency fan-out requires the repository test suite as a fallback.',
    });
  }

  if (args.scripts['verify']) {
    commands.push({
      kind: 'project-gate',
      command: packageScriptCommand(args.manager, 'verify'),
      reason: "Run the repository's aggregate verification gate.",
    });
  } else {
    for (const script of ['typecheck', 'check', 'lint']) {
      if (!args.scripts[script]) continue;
      commands.push({
        kind: 'project-gate',
        command: packageScriptCommand(args.manager, script),
        reason: `Run the repository's \`${script}\` gate.`,
      });
    }
  }
  return dedupeCommands(commands);
}

export async function buildVerificationPlan(
  cg: Cartograph,
  options: VerificationPlanOptions,
): Promise<VerificationPlan> {
  const ref = options.ref ?? 'HEAD';
  const changedFilesResult = resolveChangedFiles(cg.projectRoot, ref, options.files);
  if (changedFilesResult === null) {
    return VerificationPlanSchema.parse({
      status: 'blocked',
      changedFiles: [],
      indexedChangedFiles: [],
      unindexedChangedFiles: [],
      testCandidates: [],
      barrelsReached: [],
      commands: [],
      commandsExecuted: false,
      warnings: [],
      structural: null,
      errors: [`git unavailable or ref "${ref}" not found`],
    });
  }

  const changedFiles = changedFilesResult;
  const indexedPaths = buildIndexedPathSets(cg.queries);
  const indexedChangedFiles = changedFiles.filter((file) => indexedPaths.allIndexedPaths.has(file));
  const unindexedChangedFiles = changedFiles.filter((file) => !indexedPaths.allIndexedPaths.has(file));
  const affected =
    indexedChangedFiles.length > 0
      ? findAffectedTests(cg.internals.graphManager, {
          files: indexedChangedFiles,
          depth: options.depth ?? DEFAULT_VERIFY_DEPTH,
          customFilter: null,
          ...indexedPaths,
        })
      : { candidates: [], barrelsReached: [], affectedTests: new Set<string>(), totalDependents: 0 };
  const warnings = buildVerificationWarnings(changedFiles, unindexedChangedFiles, affected.candidates);
  const commands =
    changedFiles.length === 0
      ? []
      : buildVerificationCommands({
          manager: detectPackageManager(cg.projectRoot),
          scripts: readPackageScripts(cg.projectRoot),
          candidates: affected.candidates,
          suiteRisk: affected.barrelsReached.length > 0,
        });
  const compare = await compareToRef(cg, {
    ref,
    findingsDelta: true,
    suppressLineRangeOnly: true,
  });
  if (compare.error) {
    return VerificationPlanSchema.parse({
      status: 'blocked',
      changedFiles,
      indexedChangedFiles,
      unindexedChangedFiles,
      testCandidates: affected.candidates,
      barrelsReached: affected.barrelsReached,
      commands,
      commandsExecuted: false,
      warnings,
      structural: null,
      errors: [compare.error],
    });
  }

  return VerificationPlanSchema.parse({
    status: changedFiles.length === 0 ? 'clean' : 'ready',
    changedFiles,
    indexedChangedFiles,
    unindexedChangedFiles,
    testCandidates: affected.candidates,
    barrelsReached: affected.barrelsReached,
    commands,
    commandsExecuted: false,
    warnings,
    structural: summarizeCompare(compare),
  });
}

function targetedTestCommand(
  manager: PackageManager,
  scripts: Readonly<Record<string, string>>,
  tests: readonly string[],
): string | null {
  if (scripts['test']) return packageScriptCommand(manager, 'test', [...tests]);
  if (manager === 'bun') return `bun test ${tests.map(shellQuote).join(' ')}`;
  return null;
}

function resolveChangedFiles(
  projectRoot: string,
  ref: string,
  explicit: readonly string[] | undefined,
): string[] | null {
  if (explicit) return [...new Set(explicit)].sort((a, b) => a.localeCompare(b));
  const changed = listChangedFilesSince(projectRoot, ref);
  return changed ? [...new Set(changed)].sort((a, b) => a.localeCompare(b)) : null;
}

function buildVerificationWarnings(
  changedFiles: readonly string[],
  unindexedChangedFiles: readonly string[],
  candidates: readonly AffectedTestCandidate[],
): string[] {
  const warnings: string[] = [];
  if (unindexedChangedFiles.length > 0) {
    warnings.push(
      `${unindexedChangedFiles.length} changed file${unindexedChangedFiles.length === 1 ? ' is' : 's are'} outside the code graph; test selection cannot cover them.`,
    );
  }
  if (changedFiles.length > 0 && candidates.length === 0) {
    warnings.push(
      'No affected tests were selected from the dependency graph; use the full-suite fallback when available.',
    );
  }
  return warnings;
}

function summarizeCompare(result: CompareResult): VerificationStructuralSummary {
  let findingsIntroduced = 0;
  let findingsCleared = 0;
  const findingDiagnostics: string[] = [];
  for (const file of result.files) {
    const delta = file.findingsDelta;
    if (!delta) continue;
    findingsIntroduced += delta.added.length;
    findingsCleared += delta.cleared.length;
    findingDiagnostics.push(...(delta.errors ?? []));
  }
  return {
    ref: result.ref,
    filesScanned: result.filesScanned,
    filesChanged: result.filesChanged,
    filesSkipped: result.filesSkipped,
    symbolsAdded: result.totals.added,
    symbolsRemoved: result.totals.removed,
    symbolsModified: result.totals.modified,
    findingsIntroduced,
    findingsCleared,
    findingDiagnostics,
  };
}

function dedupeCommands(commands: readonly VerificationCommand[]): VerificationCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.command)) return false;
    seen.add(command.command);
    return true;
  });
}
