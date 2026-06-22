import { DEFAULT_DEPTH, type AffectedCoreInput, type IndexedPathSets } from './affected-core.js';
import type { PackageManager } from '../../package-scripts.js';
import { errMsg } from '../../errors.js';
import {
  type AffectedOptions,
  type AffectedRenderStyle,
  type ChangedFilesResult,
  buildAffectedFilter,
  collectExplicitChangedFiles,
  parseAffectedDepth,
  parseStdinFileList,
  renderAffectedOutput,
  renderNoDerivedChanges,
  validateAffectedIndexedPaths,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import type Cartograph from '../../index.js';
import type { QueryBuilder } from '../../db/queries.js';
import type { GraphQueryManager } from '../../graph/index.js';

type CommandLike = CliOptionCommand;

interface AffectedCartographModule {
  default: {
    open: (projectPath: string) => Promise<Cartograph>;
  };
}

interface AffectedPackageDeps {
  detectPackageManager: (projectPath: string) => PackageManager;
  readPackageScripts: (projectPath: string) => Record<string, string>;
  packageScriptCommand: (manager: PackageManager, script: string, args?: string[]) => string;
}

export interface AffectedCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<AffectedCartographModule>;
  runViaMCP?: unknown;
  isInitialized: (projectPath: string) => boolean;
  buildIndexedPathSets: (queries: QueryBuilder) => IndexedPathSets;
  findAffectedTests: (
    graphManager: GraphQueryManager,
    input: AffectedCoreInput,
  ) => { affectedTests: Set<string>; totalDependents: number; barrelsReached: string[] };
  loadGitUtils: () => Promise<{ listChangedFilesSince: (projectPath: string, ref: string) => string[] | null }>;
  readStdin: () => string;
  packageDeps: AffectedPackageDeps;
  writeLine?: (message?: string) => void;
  style?: AffectedRenderStyle;
}

export function registerAffectedCommand(deps: AffectedCommandDeps): void {
  deps.program
    .command('affected [files...]')
    .description('Find test files affected by changed source files (defaults to `git diff HEAD` when no files passed)')
    .option('-p, --project-path <path>', 'Project path')
    .option('--files <paths...>', 'Alias for positional file arguments — mirrors the MCP `files` param name')
    .option('--stdin', 'Read file list from stdin (one per line)')
    .option('-d, --depth <number>', 'Max dependency traversal depth', String(DEFAULT_DEPTH))
    .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
    .option(
      '--include-commands',
      'Print conservative package-script verification commands for affected tests plus typecheck/lint when scripts exist.',
    )
    .option(
      '--include-tests',
      "Include test-file targets when walking the dependents graph (mirrors the MCP `includeTests` flag's surface; default off — affected reports only test files, and this surface keeps the canonical no-op behavior so a script can pass the flag uniformly across surfaces).",
    )
    .option('-j, --json', 'Output as JSON')
    .option('-q, --quiet', 'Only output file paths, no decoration')
    .action(async (fileArgs: string[], options: AffectedOptions) => {
      await handleAffectedCommand(fileArgs, options, deps);
    });
}

export async function handleAffectedCommand(
  fileArgs: string[],
  options: AffectedOptions,
  deps: AffectedCommandDeps,
): Promise<void> {
  const projectPath = deps.resolveProjectPath(options.projectPath);

  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const changed = await collectChangedFilesForCli({ deps, fileArgs, options, projectPath });
    if (!changed) return;
    if (changed.changedFiles.length === 0) {
      if (!options.quiet) deps.info('No files provided. Use file arguments or --stdin.');
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const coreInput = buildAffectedCoreInput({ deps, cg, changed, options });
      if (!coreInput) return;
      const { affectedTests, totalDependents, barrelsReached } = deps.findAffectedTests(
        cg.internals.graphManager,
        coreInput,
      );
      const sortedTests = Array.from(affectedTests).sort((a, b) => a.localeCompare(b));
      const outputArgs = {
        changedFiles: changed.changedFiles,
        sortedTests,
        totalDependents,
        barrelsReached,
        derivedFromGit: changed.derivedFromGit,
        projectPath,
        options,
      };
      writeLines(
        deps,
        renderAffectedOutput({
          ...outputArgs,
          ...(options.includeCommands
            ? { verificationCommands: buildAffectedVerificationCommands(deps.packageDeps, projectPath, sortedTests) }
            : {}),
          ...(deps.style ? { style: deps.style } : {}),
        }),
      );
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Affected analysis failed: ${errMsg(err)}`);
    process.exitCode = 1;
    return;
  }
}

interface CollectChangedFilesForCliArgs {
  deps: Pick<AffectedCommandDeps, 'loadGitUtils' | 'readStdin' | 'info'>;
  fileArgs: string[];
  options: AffectedOptions;
  projectPath: string;
}

interface BuildAffectedCoreInputArgs {
  deps: Pick<AffectedCommandDeps, 'buildIndexedPathSets' | 'error' | 'info'>;
  cg: Cartograph;
  changed: ChangedFilesResult;
  options: AffectedOptions;
}

async function collectChangedFilesForCli({
  deps,
  fileArgs,
  options,
  projectPath,
}: CollectChangedFilesForCliArgs): Promise<ChangedFilesResult | null> {
  const explicitArgs = {
    fileArgs,
    ...(options.files ? { optionFiles: options.files } : {}),
    ...(options.stdin ? { stdinFiles: parseStdinFileList(deps.readStdin()), stdinRequested: true } : {}),
  };
  const explicit = collectExplicitChangedFiles(explicitArgs);
  if (explicit) return explicit;

  const { listChangedFilesSince } = await deps.loadGitUtils();
  const derived = listChangedFilesSince(projectPath, 'HEAD');
  if (derived === null) {
    if (!options.quiet) {
      deps.info('No files provided and could not derive from git (git unavailable or no HEAD ref).');
      deps.info('Use file arguments or --stdin.');
    }
    return null;
  }
  if (derived.length === 0) {
    writeNoDerivedChanges(deps, options);
    return null;
  }
  return { changedFiles: derived, derivedFromGit: true };
}

function buildAffectedCoreInput({ deps, cg, changed, options }: BuildAffectedCoreInputArgs): AffectedCoreInput | null {
  const maxDepth = parseAffectedDepth(options);
  if (!maxDepth.ok) {
    deps.error(maxDepth.error);
    process.exitCode = 1;
    return null;
  }

  const indexedPaths = deps.buildIndexedPathSets(cg.queries);
  const validation = validateAffectedIndexedPaths({
    changedFiles: changed.changedFiles,
    derivedFromGit: changed.derivedFromGit,
    allIndexedPaths: indexedPaths.allIndexedPaths,
  });
  if (!validation.ok) {
    deps.error(validation.error);
    process.exitCode = 1;
    return null;
  }
  if (validation.missing.length > 0 && !options.quiet) {
    deps.info(
      `${validation.missing.length} input path${validation.missing.length === 1 ? '' : 's'} not in the index (skipped): ${validation.missing.join(', ')}`,
    );
  }

  return {
    files: changed.changedFiles,
    depth: maxDepth.depth,
    customFilter: buildAffectedFilter(options.filter),
    ...indexedPaths,
  };
}

function buildAffectedVerificationCommands(
  deps: AffectedPackageDeps,
  projectPath: string,
  sortedTests: string[],
): string[] {
  const manager = deps.detectPackageManager(projectPath);
  const scripts = deps.readPackageScripts(projectPath);
  const commands: string[] = [];
  if (sortedTests.length > 0 && scripts['test']) commands.push(deps.packageScriptCommand(manager, 'test', sortedTests));
  for (const script of ['typecheck', 'lint']) {
    if (scripts[script]) commands.push(deps.packageScriptCommand(manager, script));
  }
  return commands;
}

function writeNoDerivedChanges(
  deps: Pick<AffectedCommandDeps, 'writeLine' | 'info'>,
  options: Pick<AffectedOptions, 'json' | 'quiet'>,
): void {
  const lines = renderNoDerivedChanges(options);
  if (options.json) {
    writeLines(deps, lines);
  } else if (!options.quiet && lines[0]) {
    deps.info(lines[0]);
  }
}

function writeLines(deps: Pick<AffectedCommandDeps, 'writeLine'>, lines: string[]): void {
  for (const line of lines) {
    if (deps.writeLine) {
      deps.writeLine(line);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
