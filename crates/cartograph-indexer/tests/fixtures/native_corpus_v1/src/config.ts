/**
 * Configuration Management
 *
 * Load, save, and validate Cartograph configuration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesGlob } from './glob.js';
import { type CartographConfig, DEFAULT_CONFIG } from './types.js';
import { MAX_INDEX_FILE_SIZE, MAX_INDEX_FILE_SIZE_LABEL } from './default-config.js';
import { normalizePath } from './utils.js';
import { migrateLegacyLlmFieldNames } from './config/legacy-llm-migration.js';
import { mergeConfig } from './config/merge.js';
import { assertValidCartographConfig } from './config/schema.js';
export { _resetLegacyLlmMigrationForTest } from './config/legacy-llm-migration.js';
export { VALID_LANGUAGES } from './config/languages.js';

/**
 * Configuration filename
 */
const CONFIG_FILENAME = 'config.json';

/** Owner-only mode for generated private config/metadata files. */
export const OWNER_ONLY_FILE_MODE = 0o600;

/** Owner-only mode for `.cartograph/` private project state. */
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * Get the config file path for a project
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.cartograph', CONFIG_FILENAME);
}

/** Best-effort permission hardening. Some platforms/filesystems ignore chmod. */
export function ensureOwnerOnlyFileMode(filePath: string): void {
  try {
    fs.chmodSync(filePath, OWNER_ONLY_FILE_MODE);
  } catch {
    // Permission tightening should never make config persistence fail on
    // filesystems that do not support POSIX modes.
  }
}

/** Best-effort owner-only mode for directories holding local private state. */
export function ensureOwnerOnlyDirectoryMode(dirPath: string): void {
  try {
    fs.chmodSync(dirPath, OWNER_ONLY_DIRECTORY_MODE);
  } catch {
    // Best effort only; creation/writes still matter more than chmod support.
  }
}

/** Ensure a private directory exists, then tighten its mode where practical. */
export function ensurePrivateDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  }
  ensureOwnerOnlyDirectoryMode(dirPath);
}

/** Copy a private file while preserving backup behavior and tightening the new copy. */
export function copyPrivateFileSync(fromPath: string, toPath: string): void {
  fs.copyFileSync(fromPath, toPath);
  ensureOwnerOnlyFileMode(toPath);
}

/**
 * Atomic owner-only write: create a private temp file, chmod it
 * best-effort, then rename over the target and chmod the final path.
 */
export function writePrivateFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensurePrivateDirectory(dir);

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: OWNER_ONLY_FILE_MODE });
    ensureOwnerOnlyFileMode(tmpPath);
    fs.renameSync(tmpPath, filePath);
    ensureOwnerOnlyFileMode(filePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best effort cleanup for a failed write; preserve the original error.
      }
    }
  }
}

// `isSafeRegex` lives in `src/regex.ts` (RE2-backed; linear-time;
// rejects lookahead / lookbehind / backreferences alongside obvious
// invalid syntax). Imported at the top of this file.

function assertPersistableMaxFileSize(configPath: string, maxFileSize: number): void {
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 1 || maxFileSize > MAX_INDEX_FILE_SIZE) {
    throw new Error(
      `Invalid configuration in ${configPath}:\nmaxFileSize must be between 1 byte and ${MAX_INDEX_FILE_SIZE_LABEL}`,
    );
  }
}

/**
 * Load configuration from a project
 */
export function loadConfig(projectRoot: string): CartographConfig {
  const configPath = getConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    // Return default config with adjusted rootDir
    return {
      ...DEFAULT_CONFIG,
      rootDir: projectRoot,
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Migrate legacy llm field names (`chat` / `askChat` / `localChat` /
    // `embeddings`) to the purpose-suffixed scheme (`summarizeLlm` /
    // `askLlm` / `localLlm` / `embeddingLlm`). One-shot: writes the
    // migrated config back to disk with a `.bak.legacy-llm-names`
    // backup so any tooling reading the file later sees the new shape.
    const migrated = migrateLegacyLlmFieldNames(parsed, configPath);

    // Merge with defaults to ensure all fields are present
    const merged = mergeConfig(DEFAULT_CONFIG, migrated as Partial<CartographConfig>);
    merged.rootDir = projectRoot; // Always use actual project root

    // Validation-only: `merged` (not parsed result data) is returned so
    // the `DEFAULT_CONFIG` getter-derived fields survive untouched. The
    // formatted error names the offending field/path so the user can fix
    // `config.json` without guessing.
    assertValidCartographConfig(configPath, merged);

    return merged;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`);
    }
    throw error;
  }
}

/**
 * Save configuration to a project
 */
export function saveConfig(projectRoot: string, config: CartographConfig): void {
  const configPath = getConfigPath(projectRoot);

  assertPersistableMaxFileSize(configPath, config.maxFileSize);

  // Create a copy without rootDir (it's always derived from project path)
  const toSave = { ...config };
  delete (toSave as Partial<CartographConfig>).rootDir;

  writePrivateFileAtomic(configPath, JSON.stringify(toSave, null, 2));
}

/**
 * Create default configuration for a new project
 */
export function createDefaultConfig(projectRoot: string): CartographConfig {
  return {
    ...DEFAULT_CONFIG,
    rootDir: projectRoot,
  };
}

/**
 * Check if a file path matches the include/exclude patterns
 */
export function shouldIncludeFile(filePath: string, config: CartographConfig): boolean {
  // Normalize to forward slashes so Windows backslash paths match glob patterns
  filePath = normalizePath(filePath);

  const matchesPattern = (pattern: string, filePath: string): boolean => {
    return matchesGlob(filePath, pattern);
  };

  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesPattern(pattern, filePath)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesPattern(pattern, filePath)) {
      return true;
    }
  }

  // Default to not including if no pattern matches
  return false;
}
