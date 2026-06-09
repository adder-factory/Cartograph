/**
 * Directory Management
 *
 * Manages the .cartograph/ directory structure for Cartograph data.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readUtf8ControlFile } from './control-file-text.js';
import { ensureOwnerOnlyFileMode, ensurePrivateDirectory, OWNER_ONLY_FILE_MODE } from './config.js';

/**
 * Cartograph directory name
 */
export const CARTOGRAPH_DIR = '.cartograph';

/**
 * Get the .cartograph directory path for a project
 */
export function getCartographDir(projectRoot: string): string {
  return path.join(projectRoot, CARTOGRAPH_DIR);
}

/**
 * Check if a project has been initialized with Cartograph
 * Requires `.cartograph/` plus either SQLite storage on disk or a
 * PostgreSQL sentinel on disk. A hand-authored PostgreSQL config alone
 * is not enough: `admin init` must still be able to bootstrap the
 * configured schema.
 */
export function isInitialized(projectRoot: string): boolean {
  const cartographDir = getCartographDir(projectRoot);
  if (!fs.existsSync(cartographDir) || !fs.statSync(cartographDir).isDirectory()) {
    return false;
  }
  // SQLite projects use this as the real DB; PostgreSQL projects use it
  // as a provider sentinel written after successful schema bootstrap.
  const dbPath = path.join(cartographDir, 'cartograph.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .cartograph/
 *
 * Walks up from the given path to find a Cartograph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .cartograph/, or null if not found
 */
export function findNearestCartographRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * Create the .cartograph directory structure
 * Note: Only throws if storage already exists, not just if `.cartograph/`
 * or a hand-authored config file exists. That lets `admin init` recover
 * partial setup and bootstrap a configured PostgreSQL schema.
 */
export function createDirectory(projectRoot: string): void {
  const cartographDir = getCartographDir(projectRoot);
  const dbPath = path.join(cartographDir, 'cartograph.db');

  // Only throw if Cartograph is actually initialized. .cartograph/ and
  // config.json alone are fine because users often create them by hand.
  if (fs.existsSync(dbPath)) {
    throw new Error(`Cartograph already initialized in ${projectRoot}`);
  }

  // Create main directory with owner-only permissions where the filesystem
  // supports POSIX modes. `.cartograph/` can contain local endpoints and
  // credentials in config backups.
  ensurePrivateDirectory(cartographDir);

  // Create .gitignore inside .cartograph (if it doesn't exist)
  const gitignorePath = path.join(cartographDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    const gitignoreContent = `# Cartograph data files
# These are local to each machine and should not be committed

# Database
*.db
*.db-wal
*.db-shm

# Cache
cache/

# Logs
*.log

# Hook markers
.dirty
`;

    fs.writeFileSync(gitignorePath, gitignoreContent, { encoding: 'utf-8', mode: OWNER_ONLY_FILE_MODE });
  }
  ensureOwnerOnlyFileMode(gitignorePath);

  // Make sure the project's own `.gitignore` excludes `.cartograph/`.
  // Without this, a fresh repo surfaces the index DB / WAL / config as
  // an untracked change in `git status`, which then pollutes every
  // git-derived "what changed" set cartograph computes.
  ensureProjectGitignoresCartographDir(projectRoot);
}

/** The line written into a project `.gitignore` to exclude the index dir.
 *  Exported so the freshness-warning filter (`isCartographOnlyGitignoreDiff`)
 *  can recognise cartograph's own init append and not treat it as a user-
 *  uncommitted change for the rest of the project's life. */
export const PROJECT_GITIGNORE_ENTRY = `${CARTOGRAPH_DIR}/`;
/** Comment placed above the appended entry so the line's origin is clear.
 *  Exported for the same reason as {@link PROJECT_GITIGNORE_ENTRY}. */
export const PROJECT_GITIGNORE_COMMENT = '# Cartograph index directory (machine-local; do not commit)';

/**
 * True when `gitignoreText` already excludes the `.cartograph/` directory.
 *
 * Recognises the exact line in any of the common forms a user (or a
 * prior init) may have written it — `.cartograph`, `.cartograph/`,
 * `/.cartograph`, `/.cartograph/`, with or without a trailing comment —
 * plus the obvious globs that subsume it (`.cartograph/**`, `*`).
 * Conservative on purpose: when in doubt it returns false so the worst
 * case is a redundant (still-idempotent) append, never a missed ignore.
 */
function gitignoreCoversCartographDir(gitignoreText: string): boolean {
  for (const rawLine of gitignoreText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Strip a leading `/` (root-anchored) and a trailing `/` (dir-only)
    // so all four anchor/slash spellings collapse to one comparison.
    const normalized = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (normalized === CARTOGRAPH_DIR) return true;
    // A glob that clearly subsumes the directory.
    if (normalized === `${CARTOGRAPH_DIR}/**` || normalized === `${CARTOGRAPH_DIR}/*`) return true;
    if (line === '*' || line === '**') return true;
  }
  return false;
}

/**
 * Ensure the project root's `.gitignore` excludes `.cartograph/`.
 *
 * - No `.gitignore` → create one containing just the entry.
 * - Exists but missing the entry → append the entry (with a comment).
 * - Already covered (exact line or a subsuming glob) → do nothing.
 *
 * Idempotent: re-running init never appends a duplicate. Best-effort —
 * filesystem errors are swallowed so a read-only project root doesn't
 * block initialization.
 */
function ensureProjectGitignoresCartographDir(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, `${PROJECT_GITIGNORE_COMMENT}\n${PROJECT_GITIGNORE_ENTRY}\n`, 'utf-8');
      return;
    }
    const existing = readUtf8ControlFile(gitignorePath, { label: 'project .gitignore', onUnreadable: 'warn' });
    if (existing === null) return;
    if (gitignoreCoversCartographDir(existing)) return;
    // Append, guaranteeing a newline before our block so we never glue
    // the entry onto a trailing line that lacked a final newline.
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gitignorePath, `${separator}${PROJECT_GITIGNORE_COMMENT}\n${PROJECT_GITIGNORE_ENTRY}\n`, 'utf-8');
  } catch {
    // Non-fatal: a missing project `.gitignore` is a hygiene nicety,
    // not a correctness requirement. The server-side filter still
    // keeps `.cartograph/` out of every changed-file set regardless.
  }
}

/**
 * Remove the .cartograph directory
 */
export function removeDirectory(projectRoot: string): void {
  const cartographDir = getCartographDir(projectRoot);

  if (!fs.existsSync(cartographDir)) {
    return;
  }

  // Verify .cartograph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(cartographDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(cartographDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(cartographDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(cartographDir, { recursive: true, force: true });
}

/**
 * Check if the .cartograph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const cartographDir = getCartographDir(projectRoot);

  if (!fs.existsSync(cartographDir)) {
    errors.push('Cartograph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(cartographDir).isDirectory()) {
    errors.push('.cartograph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair missing .gitignore (non-critical file)
  ensureGitignoreFile(cartographDir, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Auto-repair missing `.cartograph/.gitignore`. Failures are pushed to
 * `errors` (non-fatal — the caller decides whether to surface).
 */
function ensureGitignoreFile(cartographDir: string, errors: string[]): void {
  const gitignorePath = path.join(cartographDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ensureOwnerOnlyFileMode(gitignorePath);
    return;
  }
  try {
    const gitignoreContent = `# Cartograph data files\n# These are local to each machine and should not be committed\n\n# Database\n*.db\n*.db-wal\n*.db-shm\n\n# Cache\ncache/\n\n# Logs\n*.log\n\n# Hook markers\n.dirty\n`;
    fs.writeFileSync(gitignorePath, gitignoreContent, { encoding: 'utf-8', mode: OWNER_ONLY_FILE_MODE });
    ensureOwnerOnlyFileMode(gitignorePath);
  } catch {
    // Non-fatal: warn but don't block
    errors.push('.gitignore missing in .cartograph directory and could not be created');
  }
}
