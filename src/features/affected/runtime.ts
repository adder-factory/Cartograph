import { DEFAULT_DEPTH } from '../../affected-core.js';
import { globToSafeRegex } from '../../utils.js';

export interface AffectedOptions {
  projectPath?: string;
  files?: string[];
  stdin?: boolean;
  depth?: string;
  filter?: string;
  includeTests?: boolean;
  includeCommands?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export interface ChangedFilesResult {
  changedFiles: string[];
  derivedFromGit: boolean;
}

export interface AffectedOutputArgs {
  changedFiles: string[];
  sortedTests: string[];
  totalDependents: number;
  barrelsReached: string[];
  derivedFromGit: boolean;
  projectPath: string;
  options: AffectedOptions;
  verificationCommands?: string[];
  style?: AffectedRenderStyle;
}

export interface AffectedRenderStyle {
  bold: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  yellow: (s: string) => string;
}

export type ParseAffectedDepthResult = { ok: true; depth: number } | { ok: false; error: string };

export type ValidateAffectedIndexedPathsResult = { ok: true; missing: string[] } | { ok: false; error: string };

export interface ValidateAffectedIndexedPathsArgs {
  changedFiles: string[];
  derivedFromGit: boolean;
  allIndexedPaths: ReadonlySet<string>;
}

export interface CollectExplicitChangedFilesArgs {
  fileArgs: string[];
  optionFiles?: string[];
  stdinFiles?: string[];
  stdinRequested?: boolean;
}

export const AFFECTED_ROW_LIMIT = 40;

const identityStyle: AffectedRenderStyle = {
  bold: (s) => s,
  cyan: (s) => s,
  dim: (s) => s,
  yellow: (s) => s,
};

export function collectExplicitChangedFiles({
  fileArgs,
  optionFiles,
  stdinFiles,
  stdinRequested,
}: CollectExplicitChangedFilesArgs): ChangedFilesResult | null {
  const changedFiles = [...(fileArgs || []), ...(optionFiles ?? []), ...(stdinFiles ?? [])];
  if (changedFiles.length > 0 || stdinRequested) return { changedFiles, derivedFromGit: false };
  return null;
}

export function parseStdinFileList(text: string): string[] {
  return text
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

export function parseAffectedDepth(options: AffectedOptions): ParseAffectedDepthResult {
  const raw = options.depth || String(DEFAULT_DEPTH);
  const maxDepth = Number(raw);
  if (!Number.isInteger(maxDepth) || !Number.isFinite(maxDepth)) {
    return { ok: false, error: `Invalid value for --depth: "${options.depth}" is not a number` };
  }
  if (maxDepth < 1) return { ok: false, error: 'Invalid value for --depth: must be >= 1' };
  return { ok: true, depth: maxDepth };
}

export function buildAffectedFilter(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  const regexBody = globToSafeRegex(pattern);
  return regexBody === null ? null : new RegExp(regexBody);
}

export function validateAffectedIndexedPaths({
  changedFiles,
  derivedFromGit,
  allIndexedPaths,
}: ValidateAffectedIndexedPathsArgs): ValidateAffectedIndexedPathsResult {
  if (derivedFromGit) return { ok: true, missing: [] };
  const missing = changedFiles.filter((f) => !allIndexedPaths.has(f));
  if (missing.length === changedFiles.length) {
    return {
      ok: false,
      error: `None of the ${changedFiles.length} input file${changedFiles.length === 1 ? '' : 's'} match indexed paths: ${missing.join(', ')}`,
    };
  }
  return { ok: true, missing };
}

export function renderNoDerivedChanges(options: Pick<AffectedOptions, 'json' | 'quiet'>): string[] {
  if (options.json) {
    return [JSON.stringify({ changedFiles: [], affectedTests: [], totalDependentsTraversed: 0 }, null, 2)];
  }
  if (options.quiet) return [];
  return ['No uncommitted changes — nothing to re-test.'];
}

export function renderAffectedOutput(args: AffectedOutputArgs): string[] {
  if (args.options.json) return [renderAffectedJson(args)];
  if (args.options.quiet) return args.sortedTests;
  return renderAffectedHuman(args);
}

export function renderAffectedJson(args: AffectedOutputArgs): string {
  return JSON.stringify(
    {
      changedFiles: args.changedFiles,
      affectedTests: args.sortedTests,
      totalDependentsTraversed: args.totalDependents,
      barrelsReached: args.barrelsReached,
      derivedFromGit: args.derivedFromGit,
      ...(args.options.includeCommands ? { verificationCommands: args.verificationCommands ?? [] } : {}),
    },
    null,
    2,
  );
}

export function renderAffectedHuman(args: AffectedOutputArgs): string[] {
  const style = args.style ?? identityStyle;
  const lines: string[] = [];
  if (args.derivedFromGit) lines.push(...renderDerivedChangedFiles(args.changedFiles, style));
  lines.push(...renderAffectedTestList(args.sortedTests, style));
  if (args.options.includeCommands)
    lines.push(...renderAffectedVerificationCommands(args.verificationCommands ?? [], style));
  lines.push(style.dim(`Traversed ${args.totalDependents} dependent${args.totalDependents === 1 ? '' : 's'} total.`));
  lines.push(...renderBarrelWarning(args.barrelsReached, style));
  return lines;
}

export function renderAffectedVerificationCommands(
  commands: string[],
  style: Pick<AffectedRenderStyle, 'bold' | 'cyan'> = identityStyle,
): string[] {
  if (commands.length === 0) return ['', 'No package test/typecheck/lint scripts found for verification commands.'];
  return ['', style.bold('Verification commands:\n'), ...commands.map((command) => `  ${style.cyan(command)}`), ''];
}

export function renderDerivedChangedFiles(
  changedFiles: string[],
  style: Pick<AffectedRenderStyle, 'dim'> = identityStyle,
): string[] {
  return [
    style.dim(
      `\nChanged set derived from \`git diff HEAD\` (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}):`,
    ),
    ...changedFiles.map((f) => style.dim(`  ${f}`)),
  ];
}

export function renderAffectedTestList(
  sortedTests: string[],
  style: Pick<AffectedRenderStyle, 'bold' | 'cyan' | 'dim'> = identityStyle,
): string[] {
  if (sortedTests.length === 0) return ['No test files affected by the changed files.'];
  const shown = sortedTests.slice(0, AFFECTED_ROW_LIMIT);
  const lines = [style.bold(`\nAffected test files (${sortedTests.length}):\n`)];
  for (const t of shown) lines.push(`  ${style.cyan(t)}`);
  if (sortedTests.length > AFFECTED_ROW_LIMIT) {
    lines.push(
      style.dim(
        `\n  … showing first ${shown.length} of ${sortedTests.length} (sorted). Pass --filter <glob> or narrow the input set to see fewer.`,
      ),
    );
  }
  lines.push('');
  return lines;
}

export function renderBarrelWarning(
  barrelsReached: string[],
  style: Pick<AffectedRenderStyle, 'yellow'> = identityStyle,
): string[] {
  if (barrelsReached.length === 0) return [];
  const barrelList = barrelsReached.map((b) => `\`${b}\``).join(', ');
  return [
    '',
    style.yellow(
      `⚠ Traversal reached the public-API barrel (${barrelList}) — the blast radius is most of the suite. ` +
        `Narrow with \`cartograph tests-for\` for symbol-level test discovery.`,
    ),
  ];
}
