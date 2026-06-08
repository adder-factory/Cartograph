import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CartographConfig } from '../types.js';
import { logDebug } from '../errors.js';
import { matchesGlob as globMatches } from '../glob.js';
import { normalizePath } from '../utils.js';

const GIT_BINARY = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';

// Git invocation timeouts and buffer sizes shared by the git-backed
// full scan and changed-file scan.
export const GIT_PROBE_TIMEOUT_MS = 5_000;
export const GIT_LIST_TIMEOUT_MS = 30_000;
/** 50 MB — comfortably above any real-world `git ls-files` / `git diff` output. */
export const GIT_LIST_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

/** Marker file name that indicates a directory and all children should be skipped. */
export const CARTOGRAPH_IGNORE_MARKER = '.cartographignore';

/** Root-local ignore override file. Negated patterns can re-include gitignored source. */
export const LOCAL_IGNORE_FILE = '.ignore';

type LocalIgnoreDecision = 'include' | 'exclude';

interface LocalIgnoreRule {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
}

interface LocalIgnorePolicy {
  rules: LocalIgnoreRule[];
  hasIncludeRules: boolean;
}

export interface EmbeddedRepoCollectionOptions {
  rootDir: string;
  config: CartographConfig;
  submodules: ReadonlySet<string>;
}

/**
 * Parse git output as newline-delimited paths, trimmed and normalized.
 * Returns empty array on null input.
 */
export function parseGitLinesToPaths(output: string | null): string[] {
  if (!output) return [];
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) paths.push(normalizePath(trimmed));
  }
  return paths;
}

/**
 * Enumerate all initialized submodule paths recursively, relative to
 * `rootDir`. Returns [] when there are no submodules or the command
 * fails; submodule indexing is best-effort.
 */
export function getGitSubmodules(rootDir: string): string[] {
  try {
    const output = execFileSync(GIT_BINARY, ['submodule', 'foreach', '--recursive', '--quiet', 'echo "$displaypath"'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseGitLinesToPaths(output);
  } catch {
    return [];
  }
}

/**
 * Run `git ls-files -co --exclude-standard` inside a nested git repository
 * and return paths prefixed back into the parent repo's relative namespace.
 */
export function getNestedGitRepoFiles(rootDir: string, repoPath: string): string[] {
  try {
    const output = execFileSync(GIT_BINARY, ['ls-files', '-co', '--exclude-standard'], {
      cwd: path.join(rootDir, repoPath),
      encoding: 'utf-8',
      timeout: GIT_LIST_TIMEOUT_MS,
      maxBuffer: GIT_LIST_MAX_BUFFER_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseGitLinesToPrefixedPaths(output, repoPath);
  } catch {
    return [];
  }
}

/**
 * Recurse into every active submodule of `rootDir`, adding each
 * submodule-relative file path into `target` in place.
 */
export function collectSubmoduleFilesInto(target: Set<string>, rootDir: string, submodules: ReadonlySet<string>): void {
  for (const submodulePath of submodules) {
    for (const filePath of getNestedGitRepoFiles(rootDir, submodulePath)) {
      target.add(filePath);
    }
  }
}

/**
 * Recurse into standalone nested git repositories that the parent repo's
 * `.gitignore` hides from `git ls-files`.
 */
export function collectEmbeddedRepoFilesInto(target: Set<string>, options: EmbeddedRepoCollectionOptions): void {
  const { rootDir, config, submodules } = options;
  for (const repoPath of findEmbeddedGitRepositories(rootDir, config, submodules)) {
    for (const filePath of getNestedGitRepoFiles(rootDir, repoPath)) {
      target.add(filePath);
    }
  }
}

/**
 * Apply root `.ignore` as a Cartograph-local layer after git discovery.
 * Non-negated rules remove already-visible files; negated rules add matching
 * filesystem files back into the set, including files hidden by `.gitignore`.
 */
export function applyLocalIgnoreOverridesInto(target: Set<string>, rootDir: string, config: CartographConfig): void {
  const policy = loadLocalIgnorePolicy(rootDir);
  if (policy.rules.length === 0) return;

  for (const filePath of target) {
    if (getLocalIgnoreDecision(policy, filePath) === 'exclude') target.delete(filePath);
  }

  if (!policy.hasIncludeRules) return;
  for (const filePath of collectLocalIgnoreIncludedFiles(rootDir, config, policy)) {
    target.add(filePath);
  }
}

/** True when `filePath` is the root-local ignore override file. */
export function isLocalIgnoreControlPath(filePath: string): boolean {
  return normalizePath(filePath) === LOCAL_IGNORE_FILE;
}

/** True when a root `.ignore` rule explicitly excludes a path. */
export function isExcludedByLocalIgnore(rootDir: string, filePath: string): boolean {
  const policy = loadLocalIgnorePolicy(rootDir);
  if (policy.rules.length === 0) return false;
  return getLocalIgnoreDecision(policy, filePath) === 'exclude';
}

export function findEmbeddedGitRepositories(
  rootDir: string,
  config: CartographConfig,
  submodules: ReadonlySet<string> = new Set(),
): string[] {
  const repos: string[] = [];
  const visitedDirs = new Set<string>();

  const walk = (dir: string, relativePath: string): void => {
    if (relativePath && (isDirExcluded(relativePath, config.exclude) || submodules.has(relativePath))) return;
    const realDir = safeRealpath(dir);
    if (!realDir || visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    if (relativePath && hasGitMetadata(dir)) {
      repos.push(relativePath);
      return;
    }
    if (fs.existsSync(path.join(dir, CARTOGRAPH_IGNORE_MARKER))) return;

    const entries = safeReaddir(dir);
    if (!entries) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const childDir = path.join(dir, entry.name);
      const childRelative = normalizePath(path.relative(rootDir, childDir));
      walk(childDir, childRelative);
    }
  };

  walk(rootDir, '');
  return repos.sort((a, b) => a.localeCompare(b));
}

/** `realpath` with debug-log on failure. */
export function safeRealpath(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    logDebug('Skipping unresolvable directory', { dir });
    return null;
  }
}

/** `readdirSync(withFileTypes)` with debug-log on failure. */
export function safeReaddir(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    logDebug('Skipping unreadable directory', { dir, error: String(error) });
    return null;
  }
}

/**
 * Match `relativePath` against the configured exclude patterns. Tests both
 * the bare path and a `${path}/` form so directory-anchored patterns match.
 */
export function isDirExcluded(relativePath: string, exclude: readonly string[]): boolean {
  const dirPattern = relativePath + '/';
  for (const pattern of exclude) {
    if (globMatches(normalizePath(dirPattern), pattern) || globMatches(normalizePath(relativePath), pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk every parent directory of the given files and return directories
 * containing `.cartographignore`. Git-backed scans and filesystem fallback
 * scans both consume this policy so marker behavior cannot diverge.
 */
export function findCartographIgnoredDirs(rootDir: string, files: Iterable<string>): Set<string> {
  const dirs = new Set<string>(['.']);
  for (const file of files) {
    let dir = path.posix.dirname(normalizePath(file));
    while (dir && dir !== '.' && dir !== '/') {
      if (dirs.has(dir)) break;
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }

  const ignored = new Set<string>();
  for (const dir of dirs) {
    const marker =
      dir === '.' ? path.join(rootDir, CARTOGRAPH_IGNORE_MARKER) : path.join(rootDir, dir, CARTOGRAPH_IGNORE_MARKER);
    if (fs.existsSync(marker)) ignored.add(dir);
  }
  return ignored;
}

/**
 * True if `filePath` lives under a `.cartographignore` directory.
 * Directory `.` matches the project root.
 */
export function isUnderCartographIgnoredDir(filePath: string, ignoredDirs: Set<string>): boolean {
  if (ignoredDirs.size === 0) return false;
  if (ignoredDirs.has('.')) return true;
  let dir = path.posix.dirname(filePath);
  while (dir && dir !== '.' && dir !== '/') {
    if (ignoredDirs.has(dir)) return true;
    dir = path.posix.dirname(dir);
  }
  return false;
}

/** True when `dir` opts out of indexing with a `.cartographignore` marker. */
export function hasCartographIgnoreMarker(dir: string): boolean {
  return fs.existsSync(path.join(dir, CARTOGRAPH_IGNORE_MARKER));
}

function loadLocalIgnorePolicy(rootDir: string): LocalIgnorePolicy {
  const ignorePath = path.join(rootDir, LOCAL_IGNORE_FILE);
  if (!fs.existsSync(ignorePath)) return { rules: [], hasIncludeRules: false };
  let text: string;
  try {
    text = fs.readFileSync(ignorePath, 'utf-8');
  } catch (error) {
    logDebug('Skipping unreadable local ignore override file', { path: ignorePath, error: String(error) });
    return { rules: [], hasIncludeRules: false };
  }

  const rules = text
    .split(/\r?\n/)
    .map(parseLocalIgnoreRule)
    .filter((rule): rule is LocalIgnoreRule => rule !== null);
  return { rules, hasIncludeRules: rules.some((rule) => rule.negated) };
}

function parseLocalIgnoreRule(rawLine: string): LocalIgnoreRule | null {
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.startsWith(String.raw`\#`) || line.startsWith(String.raw`\!`)) {
    line = line.slice(1);
  }

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1).trim();
  }
  if (!line) return null;

  const anchored = line.startsWith('/');
  while (line.startsWith('/')) line = line.slice(1);

  const directoryOnly = line.endsWith('/');
  while (line.endsWith('/')) line = line.slice(0, -1);

  const pattern = normalizePath(line);
  if (!pattern) return null;
  return { pattern, negated, directoryOnly, anchored };
}

function collectLocalIgnoreIncludedFiles(
  rootDir: string,
  config: CartographConfig,
  policy: LocalIgnorePolicy,
): string[] {
  const files: string[] = [];
  const visitedDirs = new Set<string>();

  const walk = (dir: string): void => {
    const realDir = safeRealpath(dir);
    if (!realDir || visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    if (hasCartographIgnoreMarker(dir)) return;

    const entries = safeReaddir(dir);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.cartograph') continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));
      if (entry.isDirectory()) {
        if (!isDirExcluded(relativePath, config.exclude)) walk(fullPath);
      } else if (entry.isFile() && getLocalIgnoreDecision(policy, relativePath) === 'include') {
        files.push(relativePath);
      }
    }
  };

  walk(rootDir);
  return files;
}

function getLocalIgnoreDecision(policy: LocalIgnorePolicy, filePath: string): LocalIgnoreDecision | null {
  let decision: LocalIgnoreDecision | null = null;
  for (const rule of policy.rules) {
    if (localIgnoreRuleMatches(rule, filePath)) decision = rule.negated ? 'include' : 'exclude';
  }
  return decision;
}

function localIgnoreRuleMatches(rule: LocalIgnoreRule, filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (rule.directoryOnly) return directoryRuleMatches(rule, normalized);
  if (rule.pattern.includes('/')) return pathRuleMatches(rule, normalized);
  return basenameRuleMatches(rule.pattern, normalized);
}

function directoryRuleMatches(rule: LocalIgnoreRule, filePath: string): boolean {
  const pattern = rule.pattern;
  if (rule.anchored || pattern.includes('/')) {
    return pathMatchesPatternOrDescendant(filePath, pattern, rule.anchored);
  }
  return filePath.split('/').some((segment, index, segments) => {
    if (!safeGlobMatches(segment, pattern)) return false;
    return index < segments.length - 1;
  });
}

function pathRuleMatches(rule: LocalIgnoreRule, filePath: string): boolean {
  return pathMatchesPatternOrDescendant(filePath, rule.pattern, rule.anchored);
}

function pathMatchesPatternOrDescendant(filePath: string, pattern: string, anchored: boolean): boolean {
  if (matchPathPattern(filePath, pattern, anchored)) return true;
  return matchPathPattern(filePath, `${pattern}/**`, anchored);
}

function matchPathPattern(filePath: string, pattern: string, anchored: boolean): boolean {
  if (safeGlobMatches(filePath, pattern)) return true;
  return !anchored && safeGlobMatches(filePath, `**/${pattern}`);
}

function basenameRuleMatches(pattern: string, filePath: string): boolean {
  const segments = filePath.split('/');
  const basename = segments.at(-1) ?? '';
  if (safeGlobMatches(basename, pattern)) return true;
  return segments.slice(0, -1).some((segment) => safeGlobMatches(segment, pattern));
}

function safeGlobMatches(filePath: string, pattern: string): boolean {
  try {
    return globMatches(filePath, pattern);
  } catch {
    return false;
  }
}

function parseGitLinesToPrefixedPaths(output: string | null, prefix: string): string[] {
  if (!output) return [];
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) paths.push(normalizePath(`${prefix}/${trimmed}`));
  }
  return paths;
}

function hasGitMetadata(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}
